import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { executeTask } from "../src/execute.js";
import { SCHEMA_NAME } from "../src/sql.js";
import {
  claimTasks,
  getRun,
  markRunSleeping,
  parkRun,
  queueHealth,
  releaseTask,
  stalledRunCounts,
  startRun,
} from "../src/store.js";
import { defineWorkflow, sleep, step, type RegisteredWorkflow } from "../src/workflow.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

const worker = () => randomUUID();

function registry(...definitions: RegisteredWorkflow[]): Map<string, RegisteredWorkflow> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

async function ageTask(client: Client, interval: string): Promise<void> {
  await client.query(
    `UPDATE ${SCHEMA_NAME}.task SET available_at = now() - interval '${interval}'`,
  );
}

describe.skipIf(!hasDatabase)("queueHealth", () => {
  it("reports an empty queue", async () => {
    await withMigratedDatabase(async ({ client }) => {
      expect(await queueHealth(client)).toEqual({
        oldestUnprogressedSeconds: null,
        claimable: 0,
        leased: 0,
        expired: 0,
        scheduled: 0,
        parked: 0,
      });
    });
  });

  it("counts a run waiting for a worker", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });

      const health = await queueHealth(client);

      expect(health.claimable).toBe(1);
      expect(health.leased).toBe(0);
      expect(health.oldestUnprogressedSeconds).toBeGreaterThanOrEqual(0);
      expect(health.oldestUnprogressedSeconds).toBeLessThan(5);
    });
  });

  // Work in progress is not work waiting, so the alarm number stays quiet.
  it("counts a claimed run as leased, with nothing unprogressed", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      await claimTasks(client, { workerId: worker() });

      const health = await queueHealth(client);

      expect(health.leased).toBe(1);
      expect(health.claimable).toBe(0);
      expect(health.oldestUnprogressedSeconds).toBeNull();
    });
  });

  // A dead worker's dropped work *is* waiting, even though a lease still exists.
  it("counts an expired lease as unprogressed", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      await claimTasks(client, { workerId: worker() });
      await client.query(
        `UPDATE ${SCHEMA_NAME}.task SET lease_until = now() - interval '1 second'`,
      );

      const health = await queueHealth(client);

      expect(health.expired).toBe(1);
      expect(health.leased).toBe(0);
      expect(health.oldestUnprogressedSeconds).not.toBeNull();
    });
  });

  it("counts a sleep or backoff as scheduled, not waiting", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });
      await releaseTask(client, task!, {
        availableAt: new Date(Date.now() + 60_000),
      });

      const health = await queueHealth(client);

      expect(health.scheduled).toBe(1);
      expect(health.claimable).toBe(0);
      expect(health.parked).toBe(0);
      expect(health.oldestUnprogressedSeconds).toBeNull();
    });
  });

  it("counts a parked run separately from a scheduled one", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });
      await parkRun(client, task!, "unroutable");

      const health = await queueHealth(client);

      expect(health.parked).toBe(1);
      expect(health.scheduled).toBe(0);
      expect(health.claimable).toBe(0);
      // Parked work is not "waiting for a worker"; it is waiting for a human.
      expect(health.oldestUnprogressedSeconds).toBeNull();
    });
  });

  it("measures how long the oldest waiting task has waited", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      await ageTask(client, "90 seconds");

      const health = await queueHealth(client);

      expect(health.oldestUnprogressedSeconds).toBeGreaterThan(85);
      expect(health.oldestUnprogressedSeconds).toBeLessThan(95);
    });
  });

  it("looks at one queue at a time", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a", queue: "fast" });
      await startRun(client, { workflowName: "w", workflowId: "b", queue: "slow" });
      await startRun(client, { workflowName: "w", workflowId: "c", queue: "slow" });

      expect((await queueHealth(client, { queue: "fast" })).claimable).toBe(1);
      expect((await queueHealth(client, { queue: "slow" })).claimable).toBe(2);
      expect((await queueHealth(client)).claimable).toBe(3);
    });
  });
});

describe.skipIf(!hasDatabase)("stalledRunCounts", () => {
  it("is empty when nothing is stalled", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });

      expect([...(await stalledRunCounts(client))]).toEqual([]);
    });
  });

  it("groups open stalled runs by reason", async () => {
    await withMigratedDatabase(async ({ client }) => {
      for (const workflowId of ["a", "b"]) {
        await startRun(client, { workflowName: "w", workflowId });
      }
      const tasks = await claimTasks(client, { workerId: worker(), limit: 2 });
      await parkRun(client, tasks[0]!, "unroutable");
      await parkRun(client, tasks[1]!, "poison");

      const counts = await stalledRunCounts(client);

      expect(counts.get("unroutable")).toBe(1);
      expect(counts.get("poison")).toBe(1);
    });
  });

  it("ignores runs that have closed", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });
      await parkRun(client, task!, "unroutable");
      await client.query(
        `UPDATE ${SCHEMA_NAME}.run SET status = 'cancelled', closed_at = now()`,
      );

      expect([...(await stalledRunCounts(client))]).toEqual([]);
    });
  });
});

describe.skipIf(!hasDatabase)("markRunSleeping", () => {
  it("moves a claimed run into sleeping", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });

      expect(await markRunSleeping(client, task!)).toBe(true);
      expect((await getRun(client, runId))?.status).toBe("sleeping");
    });
  });

  it("is a no-op the second time", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });
      await markRunSleeping(client, task!);

      expect(await markRunSleeping(client, task!)).toBe(false);
    });
  });

  it("refuses a worker that has been fenced out", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, { workflowName: "w", workflowId: "a" });
      const [stale] = await claimTasks(client, { workerId: worker() });
      await client.query(
        `UPDATE ${SCHEMA_NAME}.task SET lease_until = now() - interval '1 second'`,
      );
      await claimTasks(client, { workerId: worker() });

      expect(await markRunSleeping(client, stale!)).toBe(false);
      expect((await getRun(client, runId))?.status).toBe("pending");
    });
  });
});

describe.skipIf(!hasDatabase)("a sleeping run's status", () => {
  it("reads sleeping while asleep, and runs to completion when woken", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const napping = defineWorkflow<void, string>("napping", async () => {
        await step("before", () => "b");
        await sleep("nap", "1 day");
        return step("after", () => "a");
      });

      const deps = { client, workflows: registry(napping) };
      const { runId } = await startRun(client, {
        workflowName: "napping",
        workflowId: "a",
      });

      const [first] = await claimTasks(client, { workerId: worker() });
      expect((await executeTask(deps, first!)).kind).toBe("sleeping");
      expect((await getRun(client, runId))?.status).toBe("sleeping");

      // The queue agrees: asleep is scheduled work, not waiting work.
      const health = await queueHealth(client);
      expect(health.scheduled).toBe(1);
      expect(health.oldestUnprogressedSeconds).toBeNull();

      // Bring the wake time forward and let it finish.
      await ageTask(client, "1 second");
      const [second] = await claimTasks(client, { workerId: worker() });
      expect(await executeTask(deps, second!)).toEqual({
        kind: "completed",
        output: "a",
      });
      expect((await getRun(client, runId))?.status).toBe("completed");
    });
  });
});
