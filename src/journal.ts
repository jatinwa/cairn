import { InvalidArgumentError, serialiseError } from "./errors.js";
import { SCHEMA_NAME, type SqlExecutor } from "./sql.js";
import type { TaskLease } from "./store.js";

export type StepStatus = "running" | "completed" | "failed";

export interface JournalEntry {
  readonly key: string;
  readonly status: StepStatus;
  /** Attempts made, starting at 1. Incremented by each {@link beginStep}. */
  readonly attempt: number;
  readonly output: unknown;
  readonly error: unknown;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}

/** A run's recorded steps, keyed by step key (`"charge-card#0"`). */
export type Journal = ReadonlyMap<string, JournalEntry>;

/**
 * The result of committing a step.
 *
 * - `committed` — recorded, and the task released for immediate re-claim.
 * - `fenced` — recorded, but the task was not released because the caller no
 *   longer owns it. The record still stands: it is the truth about work that
 *   genuinely happened, and the worker that now owns the run will read it from
 *   the journal and skip re-running the step. Only ownership transitions are
 *   fence-gated, never the record of completed work.
 * - `noop` — nothing to record. The step was already completed, or no such step
 *   row exists because {@link beginStep} was never called.
 */
export type StepCommitOutcome = "committed" | "fenced" | "noop";

export interface BeginStepOptions {
  readonly runId: string;
  /** A journal key from `stepKey()`, e.g. `"charge-card#0"`. */
  readonly key: string;
}

export interface CompleteStepOptions {
  readonly runId: string;
  readonly key: string;
  /** The step's result. `undefined` is stored as SQL NULL. */
  readonly output?: unknown;
}

export interface FailStepOptions {
  readonly runId: string;
  readonly key: string;
  readonly error: unknown;
  /**
   * `true` when no further attempt will follow: the step closes as `failed`.
   *
   * `false` records the error but leaves the step `running`, because a retry is
   * coming. Transient failures are expressed by releasing the task with a
   * backoff, not by closing the step — the error is kept only so a stalled run
   * can be diagnosed.
   */
  readonly permanent: boolean;
}

/**
 * Read every recorded step for a run, in one query.
 *
 * This is the first thing a resume does, and the reason step lookup is O(1)
 * afterwards rather than a query per step.
 */
export async function readJournal(
  client: SqlExecutor,
  runId: string,
): Promise<Journal> {
  const result = await client.query(
    `
    SELECT key, status, attempt, output, error, started_at, completed_at
      FROM ${SCHEMA_NAME}.step
     WHERE run_id = $1::uuid
    `,
    [runId],
  );

  const journal = new Map<string, JournalEntry>();
  for (const row of result.rows as StepRow[]) {
    journal.set(row.key, {
      key: row.key,
      status: row.status,
      attempt: row.attempt,
      output: row.output,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    });
  }
  return journal;
}

/**
 * Claim a step for execution, returning the attempt number to run as, or
 * `undefined` if the step is already completed and must not run again.
 *
 * Taking over a row left `running` by an attempt that died is the normal case,
 * not an edge case: a worker that crashed between doing the work and recording
 * it leaves exactly that. The previous attempt's error and partial output are
 * cleared and the attempt counter advances.
 *
 * A step that previously failed permanently *is* re-opened, so that retrying a
 * failed run works. A completed step never is.
 */
export async function beginStep(
  client: SqlExecutor,
  options: BeginStepOptions,
): Promise<number | undefined> {
  requireKey(options.key);

  const result = await client.query(
    `
    INSERT INTO ${SCHEMA_NAME}.step AS s (run_id, key, status, attempt)
    VALUES ($1::uuid, $2, 'running', 1)
    ON CONFLICT (run_id, key) DO UPDATE
       SET status       = 'running',
           attempt      = s.attempt + 1,
           started_at   = now(),
           completed_at = NULL,
           output       = NULL,
           output_ref   = NULL,
           error        = NULL
     WHERE s.status <> 'completed'
    RETURNING attempt
    `,
    [options.runId, options.key],
  );

  const row = (result.rows as { attempt: number }[])[0];
  return row?.attempt;
}

/**
 * Record a step's result and hand the task back, as one statement.
 *
 * This is the step commit from design doc §7.3. Recording the result, counting
 * it, and releasing the task are a single statement precisely because a crash
 * between any two of them is the failure this whole library exists to survive:
 * a result recorded but never counted, or a task never released, would stall
 * the run.
 *
 * The task is released rather than kept, so the run's own continuation is just
 * another claimable task and there is no in-memory state left to lose.
 *
 * `journal_len` counts **completed** steps. A failed step ends the run, so it
 * never contributes to the journal length that §5.3 caps.
 */
export async function completeStep(
  client: SqlExecutor,
  lease: TaskLease,
  options: CompleteStepOptions,
): Promise<StepCommitOutcome> {
  requireKey(options.key);

  const result = await client.query(
    `
    WITH recorded AS (
      UPDATE ${SCHEMA_NAME}.step
         SET status       = 'completed',
             output       = $4::jsonb,
             output_ref   = NULL,
             error        = NULL,
             completed_at = now()
       WHERE run_id = $3::uuid AND key = $5 AND status <> 'completed'
      RETURNING run_id
    ), counted AS (
      UPDATE ${SCHEMA_NAME}.run
         SET journal_len = journal_len + 1
       WHERE id = (SELECT run_id FROM recorded)
      RETURNING id
    ), released AS (
      UPDATE ${SCHEMA_NAME}.task
         SET lease_owner  = NULL,
             lease_until  = NULL,
             available_at = now(),
             attempt      = 0
       WHERE id = $1::bigint
         AND fence = $2::bigint
         AND run_id = (SELECT run_id FROM recorded)
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM counted)  AS recorded,
           (SELECT count(*)::int FROM released) AS released
    `,
    [
      lease.taskId,
      lease.fence,
      options.runId,
      options.output === undefined ? null : JSON.stringify(options.output),
      options.key,
    ],
  );

  const row = (result.rows as { recorded: number; released: number }[])[0];
  if (row === undefined || row.recorded === 0) {
    return "noop";
  }
  return row.released === 1 ? "committed" : "fenced";
}

/**
 * Record a step's failure. Returns `false` if there was no step to update.
 *
 * Deliberately takes no lease: it writes only the step row, which records what
 * actually happened, and never touches task ownership. A permanent failure
 * leaves the task alone for the caller to deal with, because closing the run is
 * the next decision and it is not this function's to make.
 */
export async function failStep(
  client: SqlExecutor,
  options: FailStepOptions,
): Promise<boolean> {
  requireKey(options.key);

  const error = JSON.stringify(serialiseError(options.error));

  const result = options.permanent
    ? await client.query(
        `
        UPDATE ${SCHEMA_NAME}.step
           SET status       = 'failed',
               error        = $3::jsonb,
               output       = NULL,
               output_ref   = NULL,
               completed_at = now()
         WHERE run_id = $1::uuid AND key = $2 AND status <> 'completed'
        RETURNING key
        `,
        [options.runId, options.key, error],
      )
    : await client.query(
        `
        UPDATE ${SCHEMA_NAME}.step
           SET error = $3::jsonb
         WHERE run_id = $1::uuid AND key = $2 AND status = 'running'
        RETURNING key
        `,
        [options.runId, options.key, error],
      );

  return result.rows.length === 1;
}

interface StepRow {
  key: string;
  status: StepStatus;
  attempt: number;
  output: unknown;
  error: unknown;
  started_at: Date;
  completed_at: Date | null;
}

function requireKey(key: string): void {
  if (typeof key !== "string" || key.trim() === "") {
    throw new InvalidArgumentError("key must be a non-empty string.");
  }
}
