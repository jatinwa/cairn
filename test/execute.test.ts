import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { executeTask, type ExecutionOutcome } from "../src/execute.js";
import { readJournal } from "../src/journal.js";
import { SCHEMA_NAME, type SqlExecutor } from "../src/sql.js";
import { claimTasks, getRun, startRun, type ClaimedTask } from "../src/store.js";
import {
  defineWorkflow,
  sleep,
  step,
  type RegisteredWorkflow,
} from "../src/workflow.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

function registry(...definitions: RegisteredWorkflow[]): Map<string, RegisteredWorkflow> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

async function startAndClaim(
  client: Client,
  workflowName: string,
  input?: unknown,
): Promise<ClaimedTask> {
  await startRun(client, { workflowName, workflowId: "cust-1", input });
  const [task] = await claimTasks(client, { workerId: randomUUID() });
  return task!;
}

/** Fails the nth query, standing in for a process that dies at that instant. */
function crashOnQuery(client: Client, nth: number): SqlExecutor {
  let seen = 0;
  return {
    query: (sql: string, values?: unknown[]) => {
      seen += 1;
      if (seen === nth) {
        return Promise.reject(new Error(`simulated crash on query ${nth}`));
      }
      return client.query(sql, values);
    },
  };
}

/** Fails the first query matching `pattern`. */
function crashOnMatching(client: Client, pattern: RegExp): SqlExecutor {
  let fired = false;
  return {
    query: (sql: string, values?: unknown[]) => {
      if (!fired && pattern.test(sql)) {
        fired = true;
        return Promise.reject(new Error(`simulated crash on ${pattern.source}`));
      }
      return client.query(sql, values);
    },
  };
}

const RECORDS_COMPLETION = /status\s*=\s*'completed'/;

describe.skipIf(!hasDatabase)("executeTask", () => {
  it("runs a workflow to completion, each step once", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const calls: string[] = [];
      const onboard = defineWorkflow<{ amount: number }, string>(
        "onboard",
        async (ctx, input) => {
          const charge = await step("charge-card", () => {
            calls.push("charge-card");
            return `ch_${input.amount}`;
          });
          await step("provision", () => {
            calls.push("provision");
            return ctx.idempotencyKey("provision");
          });
          return charge;
        },
      );

      const task = await startAndClaim(client, "onboard", { amount: 1999 });
      const outcome = await executeTask(
        { client, workflows: registry(onboard) },
        task,
      );

      expect(outcome).toEqual({ kind: "completed", output: "ch_1999" });
      expect(calls).toEqual(["charge-card", "provision"]);

      const run = await getRun(client, task.runId);
      expect(run?.status).toBe("completed");
      expect(run?.output).toBe("ch_1999");
      expect(run?.journalLen).toBe(2);
    });
  });

  it("returns recorded results on a resume without re-running them", async () => {
    await withMigratedDatabase(async ({ client }) => {
      let runs = 0;
      const once = defineWorkflow<void, number>("once", async () => {
        const value = await step("side-effect", () => {
          runs += 1;
          return runs;
        });
        await sleep("pause", "1ms");
        return value;
      });

      const deps = { client, workflows: registry(once) };
      const task = await startAndClaim(client, "once");

      const first = await executeTask(deps, task);
      expect(first.kind).toBe("sleeping");
      expect(runs).toBe(1);

      // Re-executing replays the function from line 1, but the step is in the
      // journal, so its body is not entered again.
      const second = await executeTask(deps, task);
      expect(second).toEqual({ kind: "completed", output: 1 });
      expect(runs).toBe(1);
    });
  });

  it("makes a sleeping task unclaimable until it is due", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const waits = defineWorkflow<void, void>("waits", async () => {
        await sleep("long", "1 day");
      });

      const task = await startAndClaim(client, "waits");
      const outcome = await executeTask(
        { client, workflows: registry(waits) },
        task,
      );

      expect(outcome.kind).toBe("sleeping");
      expect(await claimTasks(client, { workerId: randomUUID() })).toEqual([]);
    });
  });

  it("backs a retryable failure off and records the attempt", async () => {
    await withMigratedDatabase(async ({ client }) => {
      let tries = 0;
      const flaky = defineWorkflow<void, string>(
        "flaky",
        async () => step("call-api", () => {
          tries += 1;
          throw new Error("econnreset");
        }),
        { retry: { maxAttempts: 3, initialInterval: "5s", jitter: "none" } },
      );

      const task = await startAndClaim(client, "flaky");
      const outcome = await executeTask(
        { client, workflows: registry(flaky) },
        task,
      );

      expect(outcome.kind).toBe("retrying");
      expect(tries).toBe(1);
      expect(await claimTasks(client, { workerId: randomUUID() })).toEqual([]);
      expect((await getRun(client, task.runId))?.status).toBe("running");
    });
  });

  it("throws into the workflow once the attempts run out, where it can be caught", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const handled = defineWorkflow<void, string>(
        "handled",
        async () => {
          try {
            await step("doomed", () => {
              throw new Error("always fails");
            });
            return "unreachable";
          } catch {
            return "recovered";
          }
        },
        { retry: { maxAttempts: 1 } },
      );

      const task = await startAndClaim(client, "handled");
      const outcome = await executeTask(
        { client, workflows: registry(handled) },
        task,
      );

      expect(outcome).toEqual({ kind: "completed", output: "recovered" });
    });
  });

  it("closes the run as failed when the workflow throws", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const broken = defineWorkflow<void, never>(
        "broken",
        async () => {
          await step("doomed", () => {
            throw new TypeError("nope");
          });
          throw new Error("unreachable");
        },
        { retry: { maxAttempts: 1 } },
      );

      const task = await startAndClaim(client, "broken");
      const outcome = await executeTask(
        { client, workflows: registry(broken) },
        task,
      );

      expect(outcome.kind).toBe("failed");
      const run = await getRun(client, task.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatchObject({ type: "TypeError", message: "nope" });
    });
  });

  // Research §5 found that a Temporal workflow which cannot progress retries
  // forever and never says so. A run nothing can execute must stop loudly.
  it("parks a run no registered workflow can execute", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const task = await startAndClaim(client, "nobody-knows-this");
      const outcome = await executeTask({ client, workflows: registry() }, task);

      expect(outcome).toEqual({
        kind: "unroutable",
        workflowName: "nobody-knows-this",
      });
      expect((await getRun(client, task.runId))?.stallReason).toBe("unroutable");
      expect(await claimTasks(client, { workerId: randomUUID() })).toEqual([]);

      const { rows } = await client.query<{ available_at: Date | string }>(
        `SELECT available_at FROM ${SCHEMA_NAME}.task`,
      );
      expect(String(rows[0]!.available_at)).toMatch(/infinity/i);
    });
  });

  it("abandons the attempt when the engine's own write fails", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const simple = defineWorkflow<void, string>("simple", async () =>
        step("a", () => "A"),
      );

      const task = await startAndClaim(client, "simple");
      const outcome = await executeTask(
        {
          client: crashOnMatching(client, RECORDS_COMPLETION),
          workflows: registry(simple),
        },
        task,
      );

      expect(outcome.kind).toBe("abandoned");
      // Left open for another worker once the lease expires.
      expect((await getRun(client, task.runId))?.closedAt).toBeNull();
    });
  });

  // A workflow's own try/catch can swallow the EngineError. Carrying on past a
  // write that never landed would be far worse than abandoning, so the
  // executor reads the failure off the execution state, not off the throw.
  it("abandons even when the workflow swallows the engine error", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const swallows = defineWorkflow<void, string>("swallows", async () => {
        try {
          await step("a", () => "A");
        } catch {
          // deliberately ignored, as real code sometimes does
        }
        return "carried on regardless";
      });

      const task = await startAndClaim(client, "swallows");
      const outcome = await executeTask(
        {
          client: crashOnMatching(client, RECORDS_COMPLETION),
          workflows: registry(swallows),
        },
        task,
      );

      expect(outcome.kind).toBe("abandoned");
      expect((await getRun(client, task.runId))?.closedAt).toBeNull();
    });
  });
});

describe.skipIf(!hasDatabase)("the crash matrix", () => {
  // A clean two-step run makes exactly these database calls:
  //   1 getRun  2 markRunRunning  3 readJournal
  //   4 beginStep a  5 completeStep a  6 beginStep b  7 completeStep b
  //   8 closeRun
  // If that count changes, the assertion inside the loop says so.
  const QUERIES = 8;

  it(
    "recovers from a crash at any one of the engine's database calls",
    async () => {
      for (let failAt = 1; failAt <= QUERIES; failAt++) {
        await withMigratedDatabase(async ({ client }) => {
          const calls: string[] = [];
          const two = defineWorkflow<void, string>("two", async () => {
            await step("a", () => {
              calls.push("a");
              return "A";
            });
            await step("b", () => {
              calls.push("b");
              return "B";
            });
            return "done";
          });

          const deps = { client, workflows: registry(two) };
          const task = await startAndClaim(client, "two");

          const crashed: ExecutionOutcome | "threw" = await executeTask(
            { ...deps, client: crashOnQuery(client, failAt) },
            task,
          ).catch(() => "threw" as const);

          expect(
            crashed === "threw" ? "threw" : crashed.kind,
            `query ${failAt} of ${QUERIES} should have been reached and interrupted`,
          ).not.toBe("completed");

          // Recover. More than one pass may be needed: a crash during a step's
          // own bookkeeping leaves the following steps still to do.
          let outcome = await executeTask(deps, task);
          for (let pass = 0; pass < 4 && outcome.kind === "abandoned"; pass++) {
            outcome = await executeTask(deps, task);
          }

          expect(outcome.kind, `recovery after a crash at query ${failAt}`).toBe(
            "completed",
          );

          const journal = await readJournal(client, task.runId);
          const entries = [...journal.values()];

          // Exactly-once recording: two steps, both completed, no duplicates.
          expect(journal.size, `journal after a crash at query ${failAt}`).toBe(2);
          expect(entries.every((entry) => entry.status === "completed")).toBe(true);

          // At-least-once execution: both side effects really happened.
          expect(calls).toContain("a");
          expect(calls).toContain("b");

          expect((await getRun(client, task.runId))?.status).toBe("completed");
        });
      }
    },
    180_000,
  );

  // The honest face of at-least-once. A crash between doing the work and
  // writing it down *must* re-run the work, and this proves it rather than
  // leaving it as a caveat in the README.
  it("re-runs a step whose result was lost before it could be recorded", async () => {
    await withMigratedDatabase(async ({ client }) => {
      let charges = 0;
      const charge = defineWorkflow<void, string>("charge", async () =>
        step("charge-card", () => {
          charges += 1;
          return `ch_${charges}`;
        }),
      );

      const deps = { client, workflows: registry(charge) };
      const task = await startAndClaim(client, "charge");

      const first = await executeTask(
        { ...deps, client: crashOnMatching(client, RECORDS_COMPLETION) },
        task,
      );
      expect(first.kind).toBe("abandoned");
      expect(charges).toBe(1);

      const second = await executeTask(deps, task);

      expect(second.kind).toBe("completed");
      expect(charges).toBe(2); // the side effect happened twice
      expect((await readJournal(client, task.runId)).size).toBe(1); // recorded once
    });
  });
});

describe("step and sleep outside a workflow", () => {
  it("refuse to run", async () => {
    await expect(step("a", () => 1)).rejects.toThrow(/outside a workflow/);
    await expect(sleep("a", "1s")).rejects.toThrow(/outside a workflow/);
  });
});
