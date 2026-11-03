import { randomUUID } from "node:crypto";

import { Client } from "pg";

const url = process.env.DATABASE_URL;

/** Whether a Postgres is reachable, and so whether database tests should run. */
export const hasDatabase = typeof url === "string" && url !== "";

export interface TemporaryDatabase {
  /** A connected client, already pointed at the throwaway database. */
  readonly client: Client;
  /** Its connection string, for tests that need a second connection. */
  readonly url: string;
}

/**
 * Run `body` against a freshly created, empty database, then drop it.
 *
 * A separate database per test rather than a shared one with cleanup between
 * cases: migrations are DDL, and DDL is exactly what is hardest to undo
 * reliably. Creating a database costs a few milliseconds and buys complete
 * isolation.
 */
export async function withTemporaryDatabase<T>(
  body: (database: TemporaryDatabase) => Promise<T>,
): Promise<T> {
  if (!hasDatabase) {
    throw new Error("withTemporaryDatabase requires DATABASE_URL to be set.");
  }

  const name = `cairn_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();

  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const temporaryUrl = withDatabaseName(url!, name);
    const client = new Client({ connectionString: temporaryUrl });
    await client.connect();

    try {
      return await body({ client, url: temporaryUrl });
    } finally {
      await client.end();
      await dropDatabase(admin, name);
    }
  } finally {
    await admin.end();
  }
}

function withDatabaseName(connectionString: string, database: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function dropDatabase(admin: Client, name: string): Promise<void> {
  try {
    // FORCE needs Postgres 13+; fall back for anything older.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } catch {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  }
}
