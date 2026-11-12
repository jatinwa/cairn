import { randomUUID } from "node:crypto";

import { Pool, type Client } from "pg";
import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "../src/errors.js";
import { readJournal } from "../src/journal.js";
import { SCHEMA_NAME, type SqlExecutor } from "../src/sql.js";
import { claimTasks, getRun, startRun } from "../src/store.js";
import { defineWorkflow, step, sleep } from "../src/workflow.js";
import {
  createWorker,
  waitForRun,
  type Worker,
  type WorkerEvent,
  type WorkerOptions,
} from "../src/worker.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * A worker needs a pool, not a single client: its heartbeats overlap the
 * queries of the task they keep alive, so there is always more than one query
 * in flight. Tests use the pool for the worker and the plain client for setup
 * and assertions.
 */
async function withPool<T>(url: string, body: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 6 });
  try {
    return await body(pool);
  } finally {
    await pool.end();
  }
}

async function withWorker<T>(
  options: WorkerOptions,
  body: (worker: Worker) => Promise<T>,
): Promise<T> {
  const worker = createWorker(options);
  worker.start();
  try {
    return await body(worker);
  } finally {
    await worker.stop({ timeout: "5s" });
  }
}

/** Fails the claim query — and only the claim query — its first `times` calls. */
function failClaims(source: SqlExecutor, times: number): SqlExecutor {
  let failed = 0;
  return {
    query: (sql: string, values?: unknown[]) => {
      if (/SKIP LOCKED/.test(sql) && failed < times) {
        failed += 1;
        return Promise.reject(new Error("database unreachable"));
      }
      return source.query(sql, values);
    },
  };
}

async function taskRow(client: Client) {
  const { rows } = await client.query<{
    lease_owner: string | null;
    available_at: Date | string;
  }>(`SELECT lease_owner, available_at FROM ${SCHEMA_NAME}.task`);
  return rows[0];
}

describe("createWorker validation", () => {
  const client = { query: () => Promise.resolve({ rows: [] }) };

  it("refuses two workflows with the same name", () => {
    const a = defineWorkflow("same", () => Promise.resolve(undefined));
    const b = defineWorkflow("same", () => Promise.resolve(undefined));

    expect(() => createWorker({ client, workflows: [a, b] })).toThrow(
      InvalidArgumentError,
    );
  });

  it.each([
    [{ concurrency: 0 }, /concurrency/],
    [{ claimLimit: 0 }, /claimLimit/],
    [{ pollInterval: 0 }, /pollInterval/],
  ])("rejects %o", (overrides, pattern) => {
    expect(() => createWorker({ client, workflows: [], ...overrides })).toThrow(pattern);
  });
});

describe.skipIf(!hasDatabase)("worker", () => {
  it("runs a submitted workflow end to end", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const onboard = defineWorkflow<{ amount: number }, string>(
        "onboard",
        async (_ctx, input) => {
          const charge = await step("charge-card", () => `ch_${input.amount}`);
          await step("provision", () => "acct_1");
          return charge;
        },
      );

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [onboard], pollInterval: "50ms" },
          async () => {
            const { runId } = await startRun(client, {
              workflowName: "onboard",
              workflowId: "cust-1",
              input: { amount: 1999 },
            });

            const run = await waitForRun(client, runId, { timeout: "15s" });

            expect(run?.status).toBe("completed");
            expect(run?.output).toBe("ch_1999");
            expect((await readJournal(client, runId)).size).toBe(2);
          },
        );
      });
    });
  });

  // The lease exists to detect a dead worker, not a slow one. A step that takes
  // longer than the lease must keep its run, which only heartbeats can do.
  it("holds a run through a step that outlasts the lease", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const held = gate();
      let started = false;

      const slow = defineWorkflow<void, string>("slow", async () =>
        step("wait", async () => {
          started = true;
          await held.wait;
          return "ok";
        }),
      );

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [slow], pollInterval: "50ms", leaseFor: "1s" },
          async () => {
            const { runId } = await startRun(client, {
              workflowName: "slow",
              workflowId: "cust-1",
            });

            for (let i = 0; i < 100 && !started; i++) {
              await delay(25);
            }
            expect(started).toBe(true);

            // Two full lease periods with the step still running.
            await delay(2200);

            // Nobody else can take it, because the lease has been kept alive.
            expect(await claimTasks(client, { workerId: randomUUID() })).toEqual([]);

            held.open();
            expect((await waitForRun(client, runId, { timeout: "15s" }))?.status).toBe(
              "completed",
            );
          },
        );
      });
    });
  });

  it("runs several tasks at once, up to the concurrency limit", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      let active = 0;
      let peak = 0;

      const parallel = defineWorkflow<void, void>("parallel", async () => {
        await step("work", async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(150);
          active -= 1;
        });
      });

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [parallel], pollInterval: "25ms", concurrency: 2 },
          async () => {
            // Sequentially: these share one Client, which cannot run two
            // queries at once. The worker's own pool is what handles overlap.
            const runIds: string[] = [];
            for (const workflowId of ["a", "b", "c", "d"]) {
              const { runId } = await startRun(client, {
                workflowName: "parallel",
                workflowId,
              });
              runIds.push(runId);
            }

            for (const runId of runIds) {
              expect((await waitForRun(client, runId, { timeout: "20s" }))?.status).toBe(
                "completed",
              );
            }

            expect(peak).toBeGreaterThan(1);
            expect(peak).toBeLessThanOrEqual(2);
          },
        );
      });
    });
  });

  it("picks a sleeping run back up when it comes due", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const napping = defineWorkflow<void, string>("napping", async () => {
        await step("before", () => "b");
        await sleep("nap", "300ms");
        return step("after", () => "a");
      });

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [napping], pollInterval: "50ms" },
          async () => {
            const { runId } = await startRun(client, {
              workflowName: "napping",
              workflowId: "cust-1",
            });

            const run = await waitForRun(client, runId, { timeout: "20s" });

            expect(run?.status).toBe("completed");
            expect(run?.output).toBe("a");
            // before, nap, after — the sleep is a journal entry of its own.
            expect((await readJournal(client, runId)).size).toBe(3);
          },
        );
      });
    });
  });

  it("retries a failing step after its backoff and then succeeds", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      let tries = 0;

      const flaky = defineWorkflow<void, number>(
        "flaky",
        async () =>
          step("call-api", () => {
            tries += 1;
            if (tries === 1) {
              throw new Error("econnreset");
            }
            return tries;
          }),
        { retry: { maxAttempts: 3, initialInterval: "200ms", jitter: "none" } },
      );

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [flaky], pollInterval: "50ms" },
          async () => {
            const { runId } = await startRun(client, {
              workflowName: "flaky",
              workflowId: "cust-1",
            });

            const run = await waitForRun(client, runId, { timeout: "20s" });

            expect(run?.status).toBe("completed");
            expect(run?.output).toBe(2);
            expect(tries).toBe(2);
          },
        );
      });
    });
  });

  it("parks a run it cannot route and keeps working", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const known = defineWorkflow<void, string>("known", async () =>
        step("a", () => "done"),
      );

      const stranger = await startRun(client, {
        workflowName: "unknown-to-this-worker",
        workflowId: "cust-1",
      });

      await withPool(url, async (pool) => {
        await withWorker(
          { client: pool, workflows: [known], pollInterval: "50ms" },
          async () => {
            const mine = await startRun(client, {
              workflowName: "known",
              workflowId: "cust-2",
            });

            expect(
              (await waitForRun(client, mine.runId, { timeout: "15s" }))?.status,
            ).toBe("completed");

            const parked = await getRun(client, stranger.runId);
            expect(parked?.stallReason).toBe("unroutable");
            expect(parked?.closedAt).toBeNull();
          },
        );
      });
    });
  });

  it("survives the database going away mid-poll", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const events: WorkerEvent["type"][] = [];
      const simple = defineWorkflow<void, string>("simple", async () =>
        step("a", () => "ok"),
      );

      const { runId } = await startRun(client, {
        workflowName: "simple",
        workflowId: "cust-1",
      });

      await withPool(url, async (pool) => {
        await withWorker(
          {
            client: failClaims(pool, 3),
            workflows: [simple],
            pollInterval: "50ms",
            onEvent: (event) => events.push(event.type),
          },
          async () => {
            expect((await waitForRun(client, runId, { timeout: "20s" }))?.status).toBe(
              "completed",
            );
          },
        );
      });

      expect(events).toContain("poll-failed");
    });
  });

  it("waits for in-flight work when stopping", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const held = gate();
      let started = false;

      const slow = defineWorkflow<void, string>("slow", async () =>
        step("wait", async () => {
          started = true;
          await held.wait;
          return "ok";
        }),
      );

      await withPool(url, async (pool) => {
        const worker = createWorker({
          client: pool,
          workflows: [slow],
          pollInterval: "25ms",
          leaseFor: "30s",
        });
        worker.start();

        const { runId } = await startRun(client, {
          workflowName: "slow",
          workflowId: "cust-1",
        });
        for (let i = 0; i < 100 && !started; i++) {
          await delay(25);
        }
        expect(started).toBe(true);

        const stopping = worker.stop({ timeout: "10s" });
        await delay(200);
        expect(worker.inFlight).toBe(1); // still waiting, as promised
        held.open();
        await stopping;

        expect(worker.inFlight).toBe(0);
        expect((await getRun(client, runId))?.status).toBe("completed");
      });
    });
  });

  // Releasing a task whose step is still running would let another worker start
  // the same side effect immediately. Waiting out the lease is slower and right.
  it("does not release a still-running task when stopping times out", async () => {
    await withMigratedDatabase(async ({ client, url }) => {
      const held = gate();
      let started = false;

      const slow = defineWorkflow<void, string>("slow", async () =>
        step("wait", async () => {
          started = true;
          await held.wait;
          return "ok";
        }),
      );

      await withPool(url, async (pool) => {
        const worker = createWorker({
          client: pool,
          workflows: [slow],
          pollInterval: "25ms",
          leaseFor: "30s",
        });
        worker.start();

        await startRun(client, { workflowName: "slow", workflowId: "cust-1" });
        for (let i = 0; i < 100 && !started; i++) {
          await delay(25);
        }

        await worker.stop({ timeout: "150ms" });

        // Still leased by this worker, not handed back.
        expect((await taskRow(client))?.lease_owner).not.toBeNull();
        expect(worker.inFlight).toBe(1);

        held.open();
        await delay(400); // let the orphaned task finish before the pool closes
      });
    });
  });
});
