import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MigrationChecksumError, MigrationError } from "./errors.js";

/**
 * The minimum a database client must provide. Anything with a compatible
 * `query` works — node-postgres, a checked-out pool client, a Kysely or
 * Drizzle connection — so this library has no runtime dependency on a driver.
 */
export interface SqlExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface Migration {
  /** Zero-padded ordering key taken from the filename, e.g. `"001"`. */
  readonly version: string;
  /** Human-readable half of the filename, e.g. `"init"`. */
  readonly name: string;
  /** The file's SQL, with line endings normalised. */
  readonly sql: string;
  /** SHA-256 of {@link sql}, as 64 hex characters. */
  readonly checksum: string;
}

export interface MigrateResult {
  /** Versions applied by this call, in order. */
  readonly applied: readonly string[];
  /** Versions that were already applied and were left alone. */
  readonly skipped: readonly string[];
}

/** The schema every cairn object lives in. */
export const SCHEMA_NAME = "cairn";

/**
 * Serialises concurrent migration runs. Any constant works as long as it never
 * changes; this one is arbitrary.
 */
const ADVISORY_LOCK_KEY = 4_113_270_001;

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);
const FILENAME = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

interface AppliedRow {
  version: string;
  checksum: string;
}

/**
 * SHA-256 of some SQL, after normalising CRLF to LF.
 *
 * The normalisation matters: without it, the same migration checked out on
 * Windows and on a Linux CI runner would produce different checksums and every
 * CI run would look like a tampered migration.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Read the bundled migrations from disk, ordered by version.
 *
 * @throws {MigrationError} if a filename is malformed or two files share a version.
 */
export async function loadMigrations(): Promise<Migration[]> {
  const directory = fileURLToPath(MIGRATIONS_DIR);

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    throw new MigrationError(`Could not read the migrations directory ${directory}.`, {
      cause,
    });
  }

  const files = entries.filter((entry) => entry.endsWith(".sql")).sort();
  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const match = FILENAME.exec(file);
    if (match === null) {
      throw new MigrationError(
        `Migration filename ${JSON.stringify(file)} must look like "001_description.sql".`,
      );
    }

    const version = match[1]!;
    const name = match[2]!;

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new MigrationError(
        `Migrations ${duplicate} and ${file} share the version ${version}.`,
      );
    }
    seen.set(version, file);

    const raw = await readFile(join(directory, file), "utf8");
    const sql = raw.replace(/\r\n/g, "\n");
    migrations.push({ version, name, sql, checksum: checksumOf(sql) });
  }

  return migrations;
}

/**
 * Apply every migration the database has not seen yet.
 *
 * Safe to call on every boot and from several processes at once: a Postgres
 * advisory lock serialises concurrent runs, and each migration is applied in
 * its own transaction, so a failure part-way leaves no half-applied migration.
 *
 * `client` must be a **dedicated connection**, not a pool. The function issues
 * `BEGIN`/`COMMIT` and holds a session-level lock, both of which need every
 * statement to land on the same backend.
 *
 * @throws {MigrationChecksumError} if an applied migration's file has changed.
 * @throws {MigrationError} if the database is ahead of the code, or a migration fails.
 */
export async function migrate(client: SqlExecutor): Promise<MigrateResult> {
  const migrations = await loadMigrations();

  // The lock is taken before any DDL, not after. `CREATE SCHEMA IF NOT EXISTS`
  // run concurrently by two processes does not serialise itself — one of them
  // fails on a duplicate key in pg_namespace — so the bookkeeping setup has to
  // be inside the lock too.
  await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    // Bookkeeping lives in the same schema as everything else, and is created
    // here rather than by a migration — it is what records that migrations ran.
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA_NAME}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA_NAME}.migration (
        version    text        PRIMARY KEY,
        name       text        NOT NULL,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = await readApplied(client);
    assertNoDrift(migrations, applied);

    const pending = migrations.filter((migration) => !applied.has(migration.version));
    assertInOrder(pending, applied);

    for (const migration of pending) {
      await applyOne(client, migration);
    }

    return {
      applied: pending.map((migration) => migration.version),
      skipped: migrations
        .filter((migration) => applied.has(migration.version))
        .map((migration) => migration.version),
    };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }
}

async function readApplied(client: SqlExecutor): Promise<Map<string, string>> {
  const result = await client.query(
    `SELECT version, checksum FROM ${SCHEMA_NAME}.migration ORDER BY version`,
  );
  const rows = result.rows as AppliedRow[];
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

/**
 * Catch the two ways the database and the code can disagree: an applied
 * migration whose file changed, and an applied migration with no file at all.
 */
function assertNoDrift(migrations: Migration[], applied: Map<string, string>): void {
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const [version, checksum] of applied) {
    const migration = byVersion.get(version);
    if (migration === undefined) {
      throw new MigrationError(
        `The database has migration ${version} applied, but no such migration exists in ` +
          `this build. The database is ahead of the code.`,
      );
    }
    if (migration.checksum !== checksum) {
      throw new MigrationChecksumError(version, checksum, migration.checksum);
    }
  }
}

/**
 * Refuse a migration numbered below one that already ran. Two branches each
 * adding `002_*.sql` is the usual cause, and applying them out of order gives
 * two databases the same version history in different orders.
 */
function assertInOrder(pending: Migration[], applied: Map<string, string>): void {
  if (applied.size === 0 || pending.length === 0) {
    return;
  }

  const highestApplied = [...applied.keys()].sort().at(-1)!;
  for (const migration of pending) {
    if (migration.version < highestApplied) {
      throw new MigrationError(
        `Migration ${migration.version} has not been applied, but ${highestApplied} has. ` +
          `Renumber it above ${highestApplied} so every database applies migrations in the ` +
          `same order.`,
      );
    }
  }
}

async function applyOne(client: SqlExecutor, migration: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${SCHEMA_NAME}.migration (version, name, checksum) VALUES ($1, $2, $3)`,
      [migration.version, migration.name, migration.checksum],
    );
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw new MigrationError(
      `Migration ${migration.version}_${migration.name} failed and was rolled back.`,
      { cause },
    );
  }
}
