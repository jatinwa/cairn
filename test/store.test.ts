import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "../src/errors.js";
import { SCHEMA_NAME } from "../src/sql.js";
import {
  claimTasks,
  deleteTask,
  getRun,
  heartbeatTask,
  releaseTask,
  startRun,
  type ClaimedTask,
} from "../src/store.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

const worker = () => randomUUID();

async function expireLease(client: Client): Promise<void> {
  await client.query(
    `UPDATE ${SCHEMA_NAME}.task SET lease_until = now() - interval '1 second'`,
  );
}

async function countTasks(client: Client): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${SCHEMA_NAME}.task`,
  );
  return Number(rows[0]!.count);
}

describe("startRun argument validation", () => {
  const client = { query: () => Promise.resolve({ rows: [] }) };

  it.each([
    [{ workflowName: "", workflowId: "a" }, /workflowName/],
    [{ workflowName: "a", workflowId: "" }, /workflowId/],
    [{ workflowName: "a", workflowId: "a", queue: "  " }, /queue/],
  ])("rejects %o", async (options, pattern) => {
    await expect(startRun(client, options)).rejects.toThrow(InvalidArgumentError);
    await expect(startRun(client, options)).rejects.toThrow(pattern);
  });
});

describe.skipIf(!hasDatabase)("startRun", () => {
  it("creates a run and exactly one task for it", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId, created } = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });

      expect(created).toBe(true);
      expect(await countTasks(client)).toBe(1);

      const { rows } = await client.query<{ run_id: string }>(
        `SELECT run_id FROM ${SCHEMA_NAME}.task`,
      );
      expect(rows[0]!.run_id).toBe(runId);
    });
  });

  it("deduplicates while a run is open", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const first = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });
      const second = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });

      expect(second.runId).toBe(first.runId);
      expect(second.created).toBe(false);
      // Critically, the duplicate start created no second task.
      expect(await countTasks(client)).toBe(1);
    });
  });

  it("treats the same workflow id under a different workflow name as distinct", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const a = await startRun(client, { workflowName: "onboard", workflowId: "x" });
      const b = await startRun(client, { workflowName: "offboard", workflowId: "x" });

      expect(b.runId).not.toBe(a.runId);
      expect(b.created).toBe(true);
    });
  });

  it("allows a new run once the previous one has closed", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const first = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });
      await client.query(
        `UPDATE ${SCHEMA_NAME}.run SET status = 'completed', closed_at = now()`,
      );

      const second = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });

      expect(second.created).toBe(true);
      expect(second.runId).not.toBe(first.runId);
    });
  });

  it("round-trips the input through jsonb", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const input = { amount: 1999, tags: ["a", "b"], nested: { ok: true } };
      const { runId } = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
        input,
      });

      const run = await getRun(client, runId);
      expect(run?.input).toEqual(input);
      expect(run?.status).toBe("pending");
      expect(run?.journalLen).toBe(0);
      expect(run?.closedAt).toBeNull();
    });
  });

  it("survives many concurrent starts of the same workflow id", async () => {
    await withMigratedDatabase(async ({ url }) => {
      const clients = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const client = new Client({ connectionString: url });
          await client.connect();
          return client;
        }),
      );

      try {
        const results = await Promise.all(
          clients.map((client) =>
            startRun(client, { workflowName: "onboard", workflowId: "cust-1" }),
          ),
        );

        // Exactly one winner, everybody agrees which run it is, one task.
        expect(results.filter((result) => result.created)).toHaveLength(1);
        expect(new Set(results.map((result) => result.runId)).size).toBe(1);
        expect(await countTasks(clients[0]!)).toBe(1);
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
    });
  });
});

describe.skipIf(!hasDatabase)("claimTasks", () => {
  it("claims a due task and takes the first fence", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
      });

      const claimed = await claimTasks(client, { workerId: worker() });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.runId).toBe(runId);
      expect(claimed[0]!.fence).toBe("1");
      expect(claimed[0]!.attempt).toBe(0);
      expect(claimed[0]!.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    });
  });

  it("ignores a task that is not due yet", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, {
        workflowName: "onboard",
        workflowId: "cust-1",
        availableAt: new Date(Date.now() + 60_000),
      });

      expect(await claimTasks(client, { workerId: worker() })).toEqual([]);
    });
  });

  it("ignores a task someone else holds a live lease on", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "onboard", workflowId: "cust-1" });
      await claimTasks(client, { workerId: worker() });

      expect(await claimTasks(client, { workerId: worker() })).toEqual([]);
    });
  });

  // This is how work is recovered from a worker that died holding a lease.
  it("reclaims a task whose lease has expired, with a new fence", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "onboard", workflowId: "cust-1" });
      const first = await claimTasks(client, { workerId: worker() });
      await expireLease(client);

      const second = await claimTasks(client, { workerId: worker() });

      expect(second).toHaveLength(1);
      expect(second[0]!.taskId).toBe(first[0]!.taskId);
      expect(second[0]!.fence).toBe("2");
    });
  });

  it("claims higher priority first, then the longest-due", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const older = new Date(Date.now() - 60_000);
      await startRun(client, { workflowName: "w", workflowId: "low", priority: 0 });
      await startRun(client, { workflowName: "w", workflowId: "high", priority: 5 });
      await startRun(client, {
        workflowName: "w",
        workflowId: "old",
        priority: 0,
        availableAt: older,
      });

      const claimed = await claimTasks(client, { workerId: worker(), limit: 3 });
      const names = await workflowIdsOf(client, claimed);

      expect(names).toEqual(["high", "old", "low"]);
    });
  });

  it("honours the limit and leaves the rest claimable", async () => {
    await withMigratedDatabase(async ({ client }) => {
      for (let i = 0; i < 5; i++) {
        await startRun(client, { workflowName: "w", workflowId: `c-${i}` });
      }

      expect(await claimTasks(client, { workerId: worker(), limit: 2 })).toHaveLength(2);
      expect(await claimTasks(client, { workerId: worker(), limit: 10 })).toHaveLength(3);
    });
  });

  it("only claims from the requested queue", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a", queue: "fast" });
      await startRun(client, { workflowName: "w", workflowId: "b", queue: "slow" });

      const fast = await claimTasks(client, { workerId: worker(), queue: "fast" });
      expect(await workflowIdsOf(client, fast)).toEqual(["a"]);
    });
  });

  // The SKIP LOCKED property: many workers, no task claimed twice, none lost.
  it("never hands the same task to two workers", async () => {
    await withMigratedDatabase(async ({ url, client }) => {
      for (let i = 0; i < 20; i++) {
        await startRun(client, { workflowName: "w", workflowId: `c-${i}` });
      }

      const clients = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const extra = new Client({ connectionString: url });
          await extra.connect();
          return extra;
        }),
      );

      try {
        const batches = await Promise.all(
          clients.map((extra) => claimTasks(extra, { workerId: worker(), limit: 20 })),
        );
        const ids = batches.flat().map((task) => task.taskId);

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(20);
      } finally {
        await Promise.all(clients.map((extra) => extra.end()));
      }
    });
  });

  it("rejects a limit below one", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await expect(
        claimTasks(client, { workerId: worker(), limit: 0 }),
      ).rejects.toThrow(InvalidArgumentError);
    });
  });
});

describe.skipIf(!hasDatabase)("leases and fencing", () => {
  it("extends a lease the caller still owns", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker(), leaseFor: "1s" });

      expect(await heartbeatTask(client, task!, "1m")).toBe(true);

      const { rows } = await client.query<{ lease_until: Date }>(
        `SELECT lease_until FROM ${SCHEMA_NAME}.task`,
      );
      expect(rows[0]!.lease_until.getTime()).toBeGreaterThan(Date.now() + 30_000);
    });
  });

  // The whole point of the fence. A worker that stalled past its lease, had the
  // task taken from it, and then woke up must not be able to write.
  it("refuses a heartbeat from a worker that has been fenced out", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [stale] = await claimTasks(client, { workerId: worker() });
      await expireLease(client);
      await claimTasks(client, { workerId: worker() });

      expect(await heartbeatTask(client, stale!)).toBe(false);
    });
  });

  it("refuses a release and a delete from a fenced worker", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [stale] = await claimTasks(client, { workerId: worker() });
      await expireLease(client);
      await claimTasks(client, { workerId: worker() });

      expect(await releaseTask(client, stale!)).toBe(false);
      expect(await deleteTask(client, stale!)).toBe(false);
      // And the task is still there, owned by its new holder.
      expect(await countTasks(client)).toBe(1);
    });
  });

  it("makes a released task immediately claimable again", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });

      expect(await releaseTask(client, task!)).toBe(true);

      const again = await claimTasks(client, { workerId: worker() });
      expect(again).toHaveLength(1);
      expect(again[0]!.fence).toBe("2");
    });
  });

  it("can release a task into the future, which is how sleep and backoff work", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });

      await releaseTask(client, task!, {
        availableAt: new Date(Date.now() + 60_000),
        attempt: 3,
      });

      expect(await claimTasks(client, { workerId: worker() })).toEqual([]);

      const { rows } = await client.query<{ attempt: number }>(
        `SELECT attempt FROM ${SCHEMA_NAME}.task`,
      );
      expect(rows[0]!.attempt).toBe(3);
    });
  });

  it("deletes a task the caller owns", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });

      expect(await deleteTask(client, task!)).toBe(true);
      expect(await countTasks(client)).toBe(0);
    });
  });

  it("rejects a negative attempt count", async () => {
    await withMigratedDatabase(async ({ client }) => {
      await startRun(client, { workflowName: "w", workflowId: "a" });
      const [task] = await claimTasks(client, { workerId: worker() });

      await expect(releaseTask(client, task!, { attempt: -1 })).rejects.toThrow(
        InvalidArgumentError,
      );
    });
  });
});

describe.skipIf(!hasDatabase)("getRun", () => {
  it("returns undefined for an unknown run", async () => {
    await withMigratedDatabase(async ({ client }) => {
      expect(await getRun(client, randomUUID())).toBeUndefined();
    });
  });
});

async function workflowIdsOf(client: Client, tasks: ClaimedTask[]): Promise<string[]> {
  const ids = tasks.map((task) => task.runId);
  const { rows } = await client.query<{ id: string; workflow_id: string }>(
    `SELECT id, workflow_id FROM ${SCHEMA_NAME}.run WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row.workflow_id]));
  return ids.map((id) => byId.get(id)!);
}
