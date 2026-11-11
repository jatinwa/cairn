import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "../src/errors.js";
import {
  beginStep,
  completeStep,
  failStep,
  readJournal,
  type Journal,
} from "../src/journal.js";
import { SCHEMA_NAME } from "../src/sql.js";
import { claimTasks, getRun, startRun, type TaskLease } from "../src/store.js";
import { hasDatabase, withMigratedDatabase } from "./helpers/database.js";

const KEY = "charge-card#0";

interface Fixture {
  runId: string;
  lease: TaskLease;
}

/** A run with its task already claimed, which is the state a worker is in. */
async function claimed(client: Client, workflowId = "cust-1"): Promise<Fixture> {
  const { runId } = await startRun(client, { workflowName: "onboard", workflowId });
  const [task] = await claimTasks(client, { workerId: randomUUID() });
  return { runId, lease: task! };
}

async function stepRow(client: Client, key = KEY) {
  const { rows } = await client.query<{
    status: string;
    attempt: number;
    output: unknown;
    error: { type: string; message: string } | null;
    completed_at: Date | null;
  }>(
    `SELECT status, attempt, output, error, completed_at
       FROM ${SCHEMA_NAME}.step WHERE key = $1`,
    [key],
  );
  return rows[0];
}

async function taskRow(client: Client) {
  const { rows } = await client.query<{
    lease_owner: string | null;
    attempt: number;
    fence: string;
  }>(`SELECT lease_owner, attempt, fence FROM ${SCHEMA_NAME}.task`);
  return rows[0];
}

describe("journal argument validation", () => {
  const client = { query: () => Promise.resolve({ rows: [] }) };

  it("rejects an empty step key", async () => {
    await expect(beginStep(client, { runId: randomUUID(), key: "" })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(
      completeStep(client, { runId: randomUUID(), key: "  " }),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      failStep(client, {
        runId: randomUUID(),
        key: "",
        error: new Error("x"),
        permanent: true,
      }),
    ).rejects.toThrow(InvalidArgumentError);
  });
});

describe.skipIf(!hasDatabase)("readJournal", () => {
  it("is empty for a run that has done nothing", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      const journal: Journal = await readJournal(client, runId);

      expect(journal.size).toBe(0);
    });
  });

  it("returns completed steps keyed by step key, with parsed output", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY, output: { id: "ch_1" } });

      const journal = await readJournal(client, runId);
      const entry = journal.get(KEY);

      expect(journal.size).toBe(1);
      expect(entry?.status).toBe("completed");
      expect(entry?.output).toEqual({ id: "ch_1" });
      expect(entry?.attempt).toBe(1);
      expect(entry?.completedAt).toBeInstanceOf(Date);
    });
  });
});

describe.skipIf(!hasDatabase)("beginStep", () => {
  it("opens a step at attempt 1", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);

      expect(await beginStep(client, { runId, key: KEY })).toBe(1);
      expect((await stepRow(client))?.status).toBe("running");
    });
  });

  // A worker that died between doing the work and recording it leaves exactly
  // this state. Taking the row over is the normal path, not an edge case.
  it("takes over a step left running, advancing the attempt and clearing the error", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await failStep(client, {
        runId,
        key: KEY,
        error: new Error("timeout"),
        permanent: false,
      });

      expect(await beginStep(client, { runId, key: KEY })).toBe(2);

      const row = await stepRow(client);
      expect(row?.status).toBe("running");
      expect(row?.error).toBeNull();
      expect(row?.completed_at).toBeNull();
    });
  });

  it("refuses to re-open a completed step", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY, output: 1 });

      expect(await beginStep(client, { runId, key: KEY })).toBeUndefined();
      expect((await stepRow(client))?.attempt).toBe(1);
    });
  });

  it("re-opens a permanently failed step, so a failed run can be retried", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await failStep(client, {
        runId,
        key: KEY,
        error: new Error("dead"),
        permanent: true,
      });

      expect(await beginStep(client, { runId, key: KEY })).toBe(2);
      expect((await stepRow(client))?.status).toBe("running");
    });
  });
});

describe.skipIf(!hasDatabase)("completeStep", () => {
  it("records the result and counts it", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });

      expect(await completeStep(client, { runId, key: KEY, output: "ok" })).toBe(true);

      expect((await stepRow(client))?.status).toBe("completed");
      expect((await stepRow(client))?.output).toBe("ok");
      expect((await getRun(client, runId))?.journalLen).toBe(1);
    });
  });

  // The executor keeps its lease and carries on to the next step, so recording
  // a result must not disturb task ownership. Releasing here is what design
  // doc §7.3 originally specified, and the amendment explains why it changed.
  it("leaves the task completely untouched", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      const before = await taskRow(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY, output: "ok" });

      expect(await taskRow(client)).toEqual(before);
      expect((await taskRow(client))?.lease_owner).not.toBeNull();
    });
  });

  // Corollary of taking no lease: a worker that lost ownership still records
  // what it genuinely did, and whoever owns the run next reads it and skips the
  // step rather than repeating the side effect.
  it("records the result even for a worker that has been fenced out", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await client.query(
        `UPDATE ${SCHEMA_NAME}.task SET lease_until = now() - interval '1 second'`,
      );
      await claimTasks(client, { workerId: randomUUID() });

      expect(await completeStep(client, { runId, key: KEY, output: "ok" })).toBe(true);
      expect((await stepRow(client))?.output).toBe("ok");
    });
  });

  it("stores an undefined result as NULL", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY });

      expect((await stepRow(client))?.output).toBeNull();
    });
  });

  it("does nothing the second time, and does not double-count", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY, output: 1 });

      expect(await completeStep(client, { runId, key: KEY, output: 2 })).toBe(false);
      expect((await getRun(client, runId))?.journalLen).toBe(1);
      expect((await stepRow(client))?.output).toBe(1);
    });
  });

  it("reports false when no step was ever opened", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);

      expect(await completeStep(client, { runId, key: KEY })).toBe(false);
    });
  });
});

describe.skipIf(!hasDatabase)("failStep", () => {
  it("closes the step and keeps the error when the failure is permanent", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });

      expect(
        await failStep(client, {
          runId,
          key: KEY,
          error: new TypeError("bad card"),
          permanent: true,
        }),
      ).toBe(true);

      const row = await stepRow(client);
      expect(row?.status).toBe("failed");
      expect(row?.completed_at).toBeInstanceOf(Date);
      expect(row?.error).toMatchObject({ type: "TypeError", message: "bad card" });
    });
  });

  it("keeps the step running when a retry is still coming", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });

      expect(
        await failStep(client, {
          runId,
          key: KEY,
          error: new Error("econnreset"),
          permanent: false,
        }),
      ).toBe(true);

      const row = await stepRow(client);
      expect(row?.status).toBe("running");
      expect(row?.completed_at).toBeNull();
      expect(row?.error).toMatchObject({ message: "econnreset" });
    });
  });

  it("does not touch the task", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      const before = await taskRow(client);
      await beginStep(client, { runId, key: KEY });
      await failStep(client, { runId, key: KEY, error: new Error("x"), permanent: true });

      expect(await taskRow(client)).toEqual(before);
    });
  });

  it("will not overwrite a completed step", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);
      await beginStep(client, { runId, key: KEY });
      await completeStep(client, { runId, key: KEY, output: "ok" });

      expect(
        await failStep(client, {
          runId,
          key: KEY,
          error: new Error("x"),
          permanent: true,
        }),
      ).toBe(false);
      expect((await stepRow(client))?.status).toBe("completed");
    });
  });

  it("reports false when there is no such step", async () => {
    await withMigratedDatabase(async ({ client }) => {
      const { runId } = await claimed(client);

      expect(
        await failStep(client, {
          runId,
          key: KEY,
          error: new Error("x"),
          permanent: false,
        }),
      ).toBe(false);
    });
  });
});
