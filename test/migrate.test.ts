import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { MigrationChecksumError } from "../src/errors.js";
import { loadMigrations, migrate, SCHEMA_NAME } from "../src/migrate.js";
import { hasDatabase, withTemporaryDatabase } from "./helpers/database.js";

const OPEN_RUN = `
  INSERT INTO ${SCHEMA_NAME}.run (id, workflow_name, workflow_id, status)
  VALUES (gen_random_uuid(), 'onboard', 'cust-1', $1)
  RETURNING id
`;

describe.skipIf(!hasDatabase)("migrate", () => {
  it("applies every migration to a fresh database", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      const migrations = await loadMigrations();
      const result = await migrate(client);

      expect(result.applied).toEqual(migrations.map((migration) => migration.version));
      expect(result.skipped).toEqual([]);
    });
  });

  it("does nothing on a second call", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      const first = await migrate(client);
      const second = await migrate(client);

      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);
    });
  });

  it("creates the core tables inside the cairn schema", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 ORDER BY table_name`,
        [SCHEMA_NAME],
      );

      expect(rows.map((row) => row.table_name)).toEqual([
        "migration",
        "run",
        "step",
        "task",
      ]);
    });
  });

  it("leaves the public schema untouched", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.tables
          WHERE table_schema = 'public'`,
      );

      expect(rows[0]!.count).toBe("0");
    });
  });

  it("records each applied migration with its checksum", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      const migrations = await loadMigrations();
      const { rows } = await client.query<{ version: string; checksum: string }>(
        `SELECT version, checksum FROM ${SCHEMA_NAME}.migration ORDER BY version`,
      );

      expect(rows).toEqual(
        migrations.map(({ version, checksum }) => ({ version, checksum })),
      );
    });
  });

  it("refuses to run when an applied migration's file has changed", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      await client.query(
        `UPDATE ${SCHEMA_NAME}.migration SET checksum = 'tampered' WHERE version = '001'`,
      );

      await expect(migrate(client)).rejects.toThrow(MigrationChecksumError);
    });
  });

  it("refuses to run when the database is ahead of the code", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      await client.query(
        `INSERT INTO ${SCHEMA_NAME}.migration (version, name, checksum)
         VALUES ('999', 'from_the_future', 'x')`,
      );

      await expect(migrate(client)).rejects.toThrow(/ahead of the code/);
    });
  });

  it("serialises two processes migrating at once", async () => {
    await withTemporaryDatabase(async ({ url }) => {
      const first = new Client({ connectionString: url });
      const second = new Client({ connectionString: url });
      await Promise.all([first.connect(), second.connect()]);

      try {
        const results = await Promise.all([migrate(first), migrate(second)]);
        const appliedCount = results.reduce(
          (total, result) => total + result.applied.length,
          0,
        );
        const migrations = await loadMigrations();

        // Exactly one of them did the work; neither failed.
        expect(appliedCount).toBe(migrations.length);
      } finally {
        await Promise.all([first.end(), second.end()]);
      }
    });
  });
});

describe.skipIf(!hasDatabase)("schema invariants", () => {
  it("allows only one open run per workflow id", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      await client.query(OPEN_RUN, ["pending"]);

      await expect(client.query(OPEN_RUN, ["running"])).rejects.toThrow(
        /run_open_per_workflow_id/,
      );
    });
  });

  it("allows a new run once the previous one has closed", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      await client.query(OPEN_RUN, ["pending"]);
      await client.query(
        `UPDATE ${SCHEMA_NAME}.run SET status = 'completed', closed_at = now()`,
      );

      await expect(client.query(OPEN_RUN, ["pending"])).resolves.toBeDefined();
    });
  });

  it("allows at most one task per run", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      const { rows } = await client.query<{ id: string }>(OPEN_RUN, ["pending"]);
      const runId = rows[0]!.id;

      await client.query(`INSERT INTO ${SCHEMA_NAME}.task (run_id) VALUES ($1)`, [runId]);

      await expect(
        client.query(`INSERT INTO ${SCHEMA_NAME}.task (run_id) VALUES ($1)`, [runId]),
      ).rejects.toThrow(/duplicate key/);
    });
  });

  it("requires closed_at exactly when the status is a closed one", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);

      await expect(client.query(OPEN_RUN, ["completed"])).rejects.toThrow(
        /run_closed_at_matches_status/,
      );
    });
  });

  it("refuses a payload that is both inline and offloaded", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);

      await expect(
        client.query(
          `INSERT INTO ${SCHEMA_NAME}.run (id, workflow_name, workflow_id, input, input_ref)
           VALUES (gen_random_uuid(), 'onboard', 'cust-2', '{}'::jsonb, 's3://bucket/key')`,
        ),
      ).rejects.toThrow(/run_input_storage_exclusive/);
    });
  });

  it("keeps a lease's owner and expiry together", async () => {
    await withTemporaryDatabase(async ({ client }) => {
      await migrate(client);
      const { rows } = await client.query<{ id: string }>(OPEN_RUN, ["pending"]);

      await expect(
        client.query(
          `INSERT INTO ${SCHEMA_NAME}.task (run_id, lease_owner) VALUES ($1, gen_random_uuid())`,
          [rows[0]!.id],
        ),
      ).rejects.toThrow(/task_lease_paired/);
    });
  });
});
