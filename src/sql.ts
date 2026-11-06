/**
 * The minimum a database client must provide. Anything with a compatible
 * `query` works — node-postgres, a checked-out pool client, a Kysely or
 * Drizzle connection — so this library has no runtime dependency on a driver.
 */
export interface SqlExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** The schema every cairn object lives in. */
export const SCHEMA_NAME = "cairn";

/**
 * The run statuses the `run_open_per_workflow_id` partial index covers, spelled
 * exactly as the index predicate spells them.
 *
 * `ON CONFLICT ... WHERE <predicate>` only infers a partial unique index when
 * the predicate it is given implies the index's own, so these two must not
 * drift apart. Changing one without the other turns deduplication off silently.
 */
export const OPEN_STATUSES_SQL = "status IN ('pending', 'running', 'sleeping')";
