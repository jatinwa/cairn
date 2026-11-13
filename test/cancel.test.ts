import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { executeTask } from "../src/execute.js";
import { readJournal } from "../src/journal.js";
import { SCHEMA_NAME } from "../src/sql.js";
import {
  cancelRun,
  claimTasks,
  getRun,
  heartbeatTask,
  startRun,
} from "../src/store.js";
import { defineWorkflow, step, type RegisteredWorkflow } from "../src/workflow.js";
import { createWorker, waitForRun } from "../src/worker.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function registry(...definitions: RegisteredWorkflow[]): Map<string, RegisteredWorkflow> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

describe.skipIf(!hasDatabase)("cancelRun", () => {
  it("closes a run nobody is working on, straight away", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });

      expect(await cancelRun(client, runId, "customer changed their mind")).toBe(
        "cancelled",
      );

      const run = await getRun(client, runId);
      expect(run?.status).toBe("cancelled");
      expect(run?.closedAt).toBeInstanceOf(Date);
      expect(run?.cancelReason).toBe("customer changed their mind");

      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${SCHEMA_NAME}.task`,
      );
      expect(rows[0]!.count).toBe("0");
    });
  });

  // A worker is holding it, so the run is not closed from underneath them:
  // the request is recorded and that worker decides when to stop.
  it("only records the request while a worker holds the run", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });
      await claimTasks(client, { workerId: randomUUID() });

      expect(await cancelRun(client, runId)).toBe("requested");

      const run = await getRun(client, runId);
      expect(run?.closedAt).toBeNull();
      expect(run?.cancelRequestedAt).toBeInstanceOf(Date);
    });
  });

  it("closes a run whose lease has expired", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });
      await claimTasks(client, { workerId: randomUUID() });
      await client.query(
        `UPDATE ${SCHEMA_NAME}.task SET lease_until = now() - interval '1 second'`,
      );

      expect(await cancelRun(client, runId)).toBe("cancelled");
    });
  });

  it("reports a run that is already closed", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });
      await cancelRun(client, runId);

      expect(await cancelRun(client, runId)).toBe("already-closed");
    });
  });

  it("reports a run that does not exist", async () => {
    await withMigratedDatabase(async ({ client }) => {
      expect(await cancelRun(client, randomUUID())).toBe("not-found");
    });
  });

  it("keeps the first reason when asked twice", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });
      await claimTasks(client, { workerId: randomUUID() });

      await cancelRun(client, runId, "first");
      await cancelRun(client, runId, "second");

      expect((await getRun(client, runId))?.cancelReason).toBe("first");
    });
  });

  it("frees the workflow id for a new run", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const first = await startRun(client, { workflowName: "w", workflowId: "cust-1" });
      await cancelRun(client, first.runId);

      const second = await startRun(client, { workflowName: "w", workflowId: "cust-1" });
      expect(second.created).toBe(true);
      expect(second.runId).not.toBe(first.runId);
    });
  });
});

describe.skipIf(!hasDatabase)("heartbeatTask and cancellation", () => {
  it("tells a working worker that its run should stop", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "w",
        workflowId: "cust-1",
      });
      const [task] = await claimTasks(client, { workerId: randomUUID() });

      expect(await heartbeatTask(client, task!)).toEqual({
        held: true,
        cancelRequested: false,
      });

      await cancelRun(client, runId);

      expect(await heartbeatTask(client, task!)).toEqual({
        held: true,
        cancelRequested: true,
      });
    });
  });
});

describe.skipIf(!hasDatabase)("executing a cancelled run", () => {
  it("stops before the first step when cancellation arrived while queued", async () => {
    await withMigratedDatabase(async ({ client }) => {
      let ran = false;
      const never = defineWorkflow<void, string>("never", async () =>
        step("should-not-run", () => {
          ran = true;
          return "x";
        }),
      );

      const { runId } = await startRun(client, {
        workflowName: "never",
        workflowId: "cust-1",
      });
      const [task] = await claimTasks(client, { workerId: randomUUID() });
      await cancelRun(client, runId);

      const outcome = await executeTask({ client, workflows: registry(never) }, task!);

      expect(outcome).toEqual({ kind: "cancelled" });
      expect(ran).toBe(false);
      expect((await getRun(client, runId))?.status).toBe("cancelled");
    });
  });
});

describe.skipIf(!hasDatabase)("cancelling work in flight", () => {
  it("interrupts a step that honours ctx.signal", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      let started = false;

      const interruptible = defineWorkflow<void, string>(
        "interruptible",
        async (ctx) =>
          step("long-call", async () => {
            started = true;
            await new Promise<void>((_resolve, reject) => {
              ctx.signal.addEventListener(
                "abort",
                () => reject(new Error("aborted by cancellation")),
                { once: true },
              );
            });
            return "never reached";
          }),
      );

      const pool = new Pool({ connectionString: url, max: 6 });
      const worker = createWorker({
        client: pool,
        workflows: [interruptible],
        pollInterval: "50ms",
        leaseFor: "1s",
      });
      worker.start();

      try {
        const { runId } = await startRun(client, {
          workflowName: "interruptible",
          workflowId: "cust-1",
        });

        for (let i = 0; i < 200 && !started; i++) {
          await delay(25);
        }
        expect(started).toBe(true);

        expect(await cancelRun(client, runId, "user pressed stop")).toBe("requested");

        const run = await waitForRun(client, runId, { timeout: "20s" });
        expect(run?.status).toBe("cancelled");
        expect(run?.cancelReason).toBe("user pressed stop");

        // Interrupted, not failed on its merits.
        const journal = await readJournal(client, runId);
        expect(journal.get("long-call#0")?.status).toBe("running");
      } finally {
        await worker.stop({ timeout: "5s" });
        await pool.end();
      }
    });
  });

  // A step that ignores the signal is not killed. It finishes, its result is
  // recorded, and the run stops at the next boundary instead.
  it("lets a step that ignores the signal finish, then stops", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      let started = false;
      let secondRan = false;
      let open!: () => void;
      const held = new Promise<void>((resolve) => {
        open = resolve;
      });

      const stubborn = defineWorkflow<void, string>("stubborn", async () => {
        await step("first", async () => {
          started = true;
          await held;
          return "done";
        });
        await step("second", () => {
          secondRan = true;
          return "also done";
        });
        return "finished";
      });

      const pool = new Pool({ connectionString: url, max: 6 });
      const worker = createWorker({
        client: pool,
        workflows: [stubborn],
        pollInterval: "50ms",
        leaseFor: "1s",
      });
      worker.start();

      try {
        const { runId } = await startRun(client, {
          workflowName: "stubborn",
          workflowId: "cust-1",
        });

        for (let i = 0; i < 200 && !started; i++) {
          await delay(25);
        }

        await cancelRun(client, runId);
        await delay(600); // let a heartbeat observe it
        open();

        const run = await waitForRun(client, runId, { timeout: "20s" });
        expect(run?.status).toBe("cancelled");

        // The first step ran to completion and is recorded; the second never started.
        const journal = await readJournal(client, runId);
        expect(journal.get("first#0")?.status).toBe("completed");
        expect(journal.get("first#0")?.output).toBe("done");
        expect(secondRan).toBe(false);
      } finally {
        await worker.stop({ timeout: "5s" });
        await pool.end();
      }
    });
  });
});
