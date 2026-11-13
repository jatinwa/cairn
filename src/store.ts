import { parseDuration, type Duration } from "./duration.js";
import { CairnError, InvalidArgumentError, serialiseError } from "./errors.js";
import { OPEN_STATUSES_SQL, SCHEMA_NAME, type SqlExecutor } from "./sql.js";

export type RunStatus =
  | "pending"
  | "running"
  | "sleeping"
  | "completed"
  | "failed"
  | "cancelled"
  | "continued";

/** The statuses a run can be closed into. */
export type ClosedRunStatus = "completed" | "failed" | "cancelled" | "continued";

const CLOSED_STATUSES: ReadonlySet<string> = new Set<ClosedRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "continued",
]);

export interface CloseRunOptions {
  readonly runId: string;
  readonly status: ClosedRunStatus;
  /** The run's result, for a `completed` close. */
  readonly output?: unknown;
  /** The failure, for a `failed` close. Serialised with `serialiseError`. */
  readonly error?: unknown;
}

/** How long a claim holds a task before another worker may take it. */
export const DEFAULT_LEASE: Duration = "30s";

/**
 * Tasks claimed per poll. Batching is not an optimisation here: at 50 workers
 * polling 10 times a second, one task per claim makes the claim query itself
 * the bottleneck long before step throughput does. See design doc §9.
 */
export const DEFAULT_CLAIM_LIMIT = 16;

/**
 * `task.id` and `task.fence` are `bigint` columns, and node-postgres returns
 * those as strings rather than silently losing precision past 2^53. They are
 * opaque tokens here, never arithmetic, so strings are the honest type.
 */
export interface TaskLease {
  readonly taskId: string;
  readonly fence: string;
}

export interface ClaimedTask extends TaskLease {
  readonly runId: string;
  readonly queue: string;
  /** Failed attempts so far on this task, 0 on a first claim. */
  readonly attempt: number;
  readonly priority: number;
  readonly leaseUntil: Date;
}

export interface StartRunOptions {
  readonly workflowName: string;
  /** Deduplication key: one open run per (workflowName, workflowId). */
  readonly workflowId: string;
  readonly input?: unknown;
  readonly queue?: string;
  /** Hold the first claim until this moment. Defaults to immediately. */
  readonly availableAt?: Date;
  /** Higher is claimed first. Defaults to 0. */
  readonly priority?: number;
}

export interface StartRunResult {
  readonly runId: string;
  /** `false` when an open run already existed and was returned instead. */
  readonly created: boolean;
}

export interface RunRecord {
  readonly id: string;
  readonly workflowName: string;
  readonly workflowId: string;
  readonly status: RunStatus;
  readonly input: unknown;
  readonly output: unknown;
  readonly error: unknown;
  readonly stallReason: string | null;
  readonly journalLen: number;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  /** Set once somebody has asked for this run to stop. */
  readonly cancelRequestedAt: Date | null;
  readonly cancelReason: string | null;
}

export type CancelResult =
  /** Nobody was working on it, so it is already closed as cancelled. */
  | "cancelled"
  /** A worker holds it; the request is recorded and it will unwind. */
  | "requested"
  | "already-closed"
  | "not-found";

export interface HeartbeatResult {
  /** `false` when the caller no longer holds the lease. */
  readonly held: boolean;
  /** `true` when somebody has asked for this run to stop. */
  readonly cancelRequested: boolean;
}

export interface ClaimOptions {
  /** Identifies the claiming worker. Any UUID, stable for the worker's life. */
  readonly workerId: string;
  readonly queue?: string;
  readonly leaseFor?: Duration;
  readonly limit?: number;
}

export interface ReleaseOptions {
  /** When the task becomes claimable again. Defaults to immediately. */
  readonly availableAt?: Date;
  /** New attempt count. Left unchanged when omitted. */
  readonly attempt?: number;
}

/**
 * Create a run and the single task that will drive it.
 *
 * One open run per `(workflowName, workflowId)`: concurrent starts race on the
 * `run_open_per_workflow_id` partial unique index, one wins, and the losers get
 * the winner's `runId` back with `created: false`. Once that run closes, the
 * pair is free again.
 *
 * The run and its task are created by a single statement, so a run can never
 * exist without a task to move it forward — which would strand it forever.
 * Being one statement also means this is safe to call inside a transaction the
 * caller already opened.
 */
export async function startRun(
  client: SqlExecutor,
  options: StartRunOptions,
): Promise<StartRunResult> {
  requireNonEmpty(options.workflowName, "workflowName");
  requireNonEmpty(options.workflowId, "workflowId");

  const queue = options.queue ?? "default";
  requireNonEmpty(queue, "queue");

  const values = [
    options.workflowName,
    options.workflowId,
    options.input === undefined ? null : JSON.stringify(options.input),
    queue,
    options.availableAt ?? null,
    options.priority ?? 0,
  ];

  // Three passes at most. The insert and the follow-up read are separate
  // statements with separate snapshots: under READ COMMITTED, `ON CONFLICT DO
  // NOTHING` sees a row another transaction has just committed, but a plain
  // SELECT in the same statement would not. So a conflict can leave us with
  // neither an inserted row nor a visible existing one, and the fix is to look
  // again. A third pass covers the existing run closing in between.
  for (let pass = 1; pass <= 3; pass++) {
    const inserted = await client.query(
      `
      WITH inserted AS (
        INSERT INTO ${SCHEMA_NAME}.run (id, workflow_name, workflow_id, input)
        VALUES (gen_random_uuid(), $1, $2, $3::jsonb)
        ON CONFLICT (workflow_name, workflow_id) WHERE ${OPEN_STATUSES_SQL}
        DO NOTHING
        RETURNING id
      ), scheduled AS (
        INSERT INTO ${SCHEMA_NAME}.task (run_id, queue, available_at, priority)
        SELECT id, $4, COALESCE($5::timestamptz, now()), $6 FROM inserted
        RETURNING run_id
      )
      SELECT id FROM inserted
      `,
      values,
    );

    const row = (inserted.rows as { id: string }[])[0];
    if (row !== undefined) {
      return { runId: row.id, created: true };
    }

    const existing = await client.query(
      `
      SELECT id FROM ${SCHEMA_NAME}.run
       WHERE workflow_name = $1 AND workflow_id = $2 AND ${OPEN_STATUSES_SQL}
       LIMIT 1
      `,
      [options.workflowName, options.workflowId],
    );

    const open = (existing.rows as { id: string }[])[0];
    if (open !== undefined) {
      return { runId: open.id, created: false };
    }
  }

  throw new CairnError(
    `Could not start ${options.workflowName}/${options.workflowId}: an open run kept ` +
      `appearing and closing. This should be transient — retry.`,
  );
}

/**
 * Take ownership of up to `limit` due tasks.
 *
 * `FOR UPDATE SKIP LOCKED` lets any number of workers claim disjoint batches
 * without blocking each other. A task whose lease has expired is claimable
 * again, which is what recovers work from a dead worker — recovery is a
 * property of this query rather than of a reaper process that could itself be
 * down.
 *
 * Every claim increments `fence`. That number is the caller's proof of
 * ownership for every subsequent write; see {@link heartbeatTask}.
 */
export async function claimTasks(
  client: SqlExecutor,
  options: ClaimOptions,
): Promise<ClaimedTask[]> {
  requireNonEmpty(options.workerId, "workerId");

  const queue = options.queue ?? "default";
  requireNonEmpty(queue, "queue");

  const limit = options.limit ?? DEFAULT_CLAIM_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidArgumentError(
      `limit must be an integer of at least 1, received ${limit}.`,
    );
  }

  const result = await client.query(
    `
    UPDATE ${SCHEMA_NAME}.task AS t
       SET lease_owner = $1::uuid,
           lease_until = now() + make_interval(secs => $2::double precision / 1000),
           fence = t.fence + 1
     WHERE t.id IN (
             SELECT c.id
               FROM ${SCHEMA_NAME}.task AS c
              WHERE c.queue = $3
                AND c.available_at <= now()
                AND (c.lease_owner IS NULL OR c.lease_until < now())
              ORDER BY c.priority DESC, c.available_at
              LIMIT $4
                FOR UPDATE SKIP LOCKED
           )
    RETURNING t.id, t.run_id, t.queue, t.attempt, t.priority, t.fence, t.lease_until
    `,
    [options.workerId, leaseMilliseconds(options.leaseFor), queue, limit],
  );

  return (result.rows as ClaimedTaskRow[]).map((row) => ({
    taskId: row.id,
    runId: row.run_id,
    queue: row.queue,
    attempt: row.attempt,
    priority: row.priority,
    fence: row.fence,
    leaseUntil: row.lease_until,
  }));
}

/**
 * Extend a lease the caller still owns. Returns `false` if it does not.
 *
 * `false` means the caller no longer holds the lease: either the fence has
 * moved, because the lease expired while this worker was stalled and someone
 * else claimed the task, or the lease was already given up. The correct
 * response to either is to stop touching the run entirely. Note what fencing
 * cannot undo — a stalled worker may already have performed a side effect,
 * which is exactly why steps are at-least-once and why idempotency keys exist.
 *
 * The `lease_owner IS NOT NULL` guard is not redundant. Without it, a heartbeat
 * on a task that had already been released would set `lease_until` while
 * `lease_owner` stayed NULL, violating the `task_lease_paired` constraint — so
 * the caller would get a Postgres error instead of a plain `held: false`.
 *
 * The same statement reports whether the run has been asked to stop. The
 * heartbeat is already the one thing a worker does regularly while a step
 * runs, so cancellation rides along with it rather than costing a query of its
 * own.
 */
export async function heartbeatTask(
  client: SqlExecutor,
  lease: TaskLease,
  leaseFor?: Duration,
): Promise<HeartbeatResult> {
  const result = await client.query(
    `
    UPDATE ${SCHEMA_NAME}.task AS t
       SET lease_until = now() + make_interval(secs => $3::double precision / 1000)
      FROM ${SCHEMA_NAME}.run AS r
     WHERE t.id = $1::bigint
       AND t.fence = $2::bigint
       AND t.lease_owner IS NOT NULL
       AND r.id = t.run_id
    RETURNING r.cancel_requested_at
    `,
    [lease.taskId, lease.fence, leaseMilliseconds(leaseFor)],
  );

  const row = (result.rows as { cancel_requested_at: Date | null }[])[0];
  if (row === undefined) {
    return { held: false, cancelRequested: false };
  }
  return { held: true, cancelRequested: row.cancel_requested_at !== null };
}

/**
 * Ask a run to stop.
 *
 * Cooperative by design. If nobody holds the run it is closed as `cancelled`
 * immediately and its task removed. If a worker does hold it, the request is
 * recorded and that worker unwinds at its next heartbeat or step boundary —
 * because yanking a run away from a worker mid-step would not stop the step,
 * it would only stop anyone hearing how it ended.
 *
 * A step already in flight still finishes and is still recorded. Cancellation
 * takes effect between steps, or inside one that honours `ctx.signal`.
 */
export async function cancelRun(
  client: SqlExecutor,
  runId: string,
  reason?: string,
): Promise<CancelResult> {
  const result = await client.query(
    `
    WITH idle AS (
      SELECT t.id
        FROM ${SCHEMA_NAME}.task AS t
       WHERE t.run_id = $1::uuid
         AND (t.lease_owner IS NULL OR t.lease_until < now())
    ), requested AS (
      -- One UPDATE, not two. Postgres silently skips a second update of the
      -- same row within one statement, so recording the request and closing
      -- the run have to happen in the same assignment list.
      UPDATE ${SCHEMA_NAME}.run AS r
         SET cancel_requested_at = COALESCE(r.cancel_requested_at, now()),
             cancel_reason       = COALESCE(r.cancel_reason, $2),
             status = CASE
                        WHEN EXISTS (SELECT 1 FROM idle)
                        THEN 'cancelled'::${SCHEMA_NAME}.run_status
                        ELSE r.status
                      END,
             closed_at = CASE
                           WHEN EXISTS (SELECT 1 FROM idle) THEN now()
                           ELSE r.closed_at
                         END
       WHERE r.id = $1::uuid AND r.closed_at IS NULL
      RETURNING r.id, r.closed_at
    ), removed AS (
      DELETE FROM ${SCHEMA_NAME}.task
       WHERE run_id = (SELECT id FROM requested WHERE closed_at IS NOT NULL)
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM requested) AS requested,
           (SELECT count(*)::int FROM removed)   AS removed,
           (SELECT count(*)::int FROM ${SCHEMA_NAME}.run WHERE id = $1::uuid) AS present
    `,
    [runId, reason ?? null],
  );

  const row = (result.rows as { requested: number; removed: number; present: number }[])[0];
  if (row === undefined || row.present === 0) {
    return "not-found";
  }
  if (row.requested === 0) {
    return "already-closed";
  }
  return row.removed === 1 ? "cancelled" : "requested";
}

/**
 * Give up a lease so the task can be claimed again, optionally later and with a
 * new attempt count. Returns `false` if the caller no longer owns it.
 *
 * This is how both retry backoff and durable sleep are expressed: both are
 * "make this claimable at a later moment".
 */
export async function releaseTask(
  client: SqlExecutor,
  lease: TaskLease,
  options: ReleaseOptions = {},
): Promise<boolean> {
  if (
    options.attempt !== undefined &&
    (!Number.isInteger(options.attempt) || options.attempt < 0)
  ) {
    throw new InvalidArgumentError(
      `attempt must be a non-negative integer, received ${options.attempt}.`,
    );
  }

  const result = await client.query(
    `
    UPDATE ${SCHEMA_NAME}.task
       SET lease_owner  = NULL,
           lease_until  = NULL,
           available_at = COALESCE($3::timestamptz, now()),
           attempt      = COALESCE($4::integer, attempt)
     WHERE id = $1::bigint AND fence = $2::bigint
    RETURNING id
    `,
    [lease.taskId, lease.fence, options.availableAt ?? null, options.attempt ?? null],
  );

  return result.rows.length === 1;
}

/**
 * Remove a task because its run has reached a terminal state. Returns `false`
 * if the caller no longer owns it.
 */
export async function deleteTask(
  client: SqlExecutor,
  lease: TaskLease,
): Promise<boolean> {
  const result = await client.query(
    `
    DELETE FROM ${SCHEMA_NAME}.task
     WHERE id = $1::bigint AND fence = $2::bigint
    RETURNING id
    `,
    [lease.taskId, lease.fence],
  );

  return result.rows.length === 1;
}

/**
 * Move a claimed run out of `pending` or `sleeping` into `running`, so its
 * status reflects what is actually happening to it. Returns `false` if the
 * caller does not own the task, or the run was already running.
 */
export async function markRunRunning(
  client: SqlExecutor,
  lease: TaskLease,
): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE ${SCHEMA_NAME}.run
       SET status = 'running'
     WHERE id = (
             SELECT run_id FROM ${SCHEMA_NAME}.task
              WHERE id = $1::bigint AND fence = $2::bigint
           )
       AND status IN ('pending', 'sleeping')
    RETURNING id
    `,
    [lease.taskId, lease.fence],
  );

  return result.rows.length === 1;
}

/**
 * Close a run and remove its task, as one statement. Returns `false` if the
 * caller no longer owns the task, the lease belongs to a different run, or the
 * run was already closed.
 *
 * Unlike recording a step, deciding a run's outcome **is** an ownership
 * transition, so this is fence-gated end to end: a worker that lost its lease
 * does not get to declare the run finished. Closing the run and deleting the
 * task are one statement because a closed run with a live task would be claimed
 * forever, and an open run with no task would never progress again.
 */
export async function closeRun(
  client: SqlExecutor,
  lease: TaskLease,
  options: CloseRunOptions,
): Promise<boolean> {
  if (!CLOSED_STATUSES.has(options.status)) {
    throw new InvalidArgumentError(
      `status must be one of ${[...CLOSED_STATUSES].join(", ")}, received ${options.status}.`,
    );
  }

  const result = await client.query(
    `
    WITH owned AS (
      SELECT run_id FROM ${SCHEMA_NAME}.task
       WHERE id = $1::bigint AND fence = $2::bigint AND run_id = $3::uuid
    ), closed AS (
      UPDATE ${SCHEMA_NAME}.run
         SET status    = $4::${SCHEMA_NAME}.run_status,
             closed_at = now(),
             output    = $5::jsonb,
             error     = $6::jsonb
       WHERE id = (SELECT run_id FROM owned) AND closed_at IS NULL
      RETURNING id
    ), removed AS (
      DELETE FROM ${SCHEMA_NAME}.task
       WHERE id = $1::bigint
         AND fence = $2::bigint
         AND EXISTS (SELECT 1 FROM closed)
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM removed) AS removed
    `,
    [
      lease.taskId,
      lease.fence,
      options.runId,
      options.status,
      options.output === undefined ? null : JSON.stringify(options.output),
      options.error === undefined ? null : JSON.stringify(serialiseError(options.error)),
    ],
  );

  const row = (result.rows as { removed: number }[])[0];
  return row?.removed === 1;
}

/**
 * Mark a run as waiting on a durable timer. Returns `false` if the caller does
 * not own the task.
 *
 * Called after the task has been released into the future, which is safe
 * because a task with a future `available_at` cannot be claimed in the
 * meantime. If the process dies between the two, the run reads `running` while
 * it sleeps — cosmetic, and the next claim corrects it through
 * {@link markRunRunning}.
 */
export async function markRunSleeping(
  client: SqlExecutor,
  lease: TaskLease,
): Promise<boolean> {
  const result = await client.query(
    `
    UPDATE ${SCHEMA_NAME}.run
       SET status = 'sleeping'
     WHERE id = (
             SELECT run_id FROM ${SCHEMA_NAME}.task
              WHERE id = $1::bigint AND fence = $2::bigint
           )
       AND status IN ('pending', 'running')
    RETURNING id
    `,
    [lease.taskId, lease.fence],
  );

  return result.rows.length === 1;
}

/**
 * Stop a run from being claimed again, recording why. Returns `false` if the
 * caller no longer owns the task.
 *
 * `available_at` is set to `'infinity'`, so the task still exists and is still
 * inspectable but can never be claimed. Un-parking is then just setting a real
 * timestamp back.
 *
 * This is the answer to the failure mode research §5 found in Temporal, where a
 * workflow that cannot progress retries with backoff forever against an
 * infinite default timeout — it stops working but never fails, and nothing
 * says so. A parked run has a `stall_reason` and shows up in
 * `cairn_run_stalled_total`.
 */
export async function parkRun(
  client: SqlExecutor,
  lease: TaskLease,
  reason: string,
): Promise<boolean> {
  requireNonEmpty(reason, "reason");

  const result = await client.query(
    `
    WITH owned AS (
      SELECT run_id FROM ${SCHEMA_NAME}.task
       WHERE id = $1::bigint AND fence = $2::bigint
    ), marked AS (
      UPDATE ${SCHEMA_NAME}.run
         SET stall_reason = $3
       WHERE id = (SELECT run_id FROM owned)
      RETURNING id
    ), parked AS (
      UPDATE ${SCHEMA_NAME}.task
         SET lease_owner  = NULL,
             lease_until  = NULL,
             available_at = 'infinity'
       WHERE id = $1::bigint
         AND fence = $2::bigint
         AND EXISTS (SELECT 1 FROM marked)
      RETURNING id
    )
    SELECT (SELECT count(*)::int FROM parked) AS parked
    `,
    [lease.taskId, lease.fence, reason],
  );

  const row = (result.rows as { parked: number }[])[0];
  return row?.parked === 1;
}

/** Read a run, or `undefined` if there is no such run. */
export async function getRun(
  client: SqlExecutor,
  runId: string,
): Promise<RunRecord | undefined> {
  const result = await client.query(
    `
    SELECT id, workflow_name, workflow_id, status, input, output, error,
           stall_reason, journal_len, created_at, closed_at,
           cancel_requested_at, cancel_reason
      FROM ${SCHEMA_NAME}.run
     WHERE id = $1::uuid
    `,
    [runId],
  );

  const row = (result.rows as RunRow[])[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    id: row.id,
    workflowName: row.workflow_name,
    workflowId: row.workflow_id,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    stallReason: row.stall_reason,
    journalLen: row.journal_len,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    cancelRequestedAt: row.cancel_requested_at,
    cancelReason: row.cancel_reason,
  };
}

export interface QueueHealth {
  /**
   * Age in seconds of the oldest task that is due and that nobody is working
   * on, or `null` when there is no such task.
   *
   * This is the number worth alerting on. Design doc §11: if it climbs,
   * something is wrong no matter what every other metric says — work is
   * waiting and not being picked up. Rates and latencies all look healthy
   * while nothing at all is happening.
   */
  readonly oldestUnprogressedSeconds: number | null;
  /** Due, unleased, waiting for a worker. */
  readonly claimable: number;
  /** Held by a worker with a live lease. */
  readonly leased: number;
  /** Held by a worker whose lease has expired — work a dead worker dropped. */
  readonly expired: number;
  /** Waiting for a future moment: a durable sleep or a retry backoff. */
  readonly scheduled: number;
  /** Parked, and so never claimable until a human intervenes. */
  readonly parked: number;
}

/**
 * One query's worth of "is the queue moving?".
 *
 * Counts every task by the state it is actually in, rather than by a status
 * column that could disagree with it.
 */
export async function queueHealth(
  client: SqlExecutor,
  options: { readonly queue?: string } = {},
): Promise<QueueHealth> {
  const result = await client.query(
    `
    SELECT
      count(*) FILTER (
        WHERE lease_owner IS NULL AND available_at <= now()
      )::int AS claimable,
      count(*) FILTER (
        WHERE lease_owner IS NOT NULL AND lease_until >= now()
      )::int AS leased,
      count(*) FILTER (
        WHERE lease_owner IS NOT NULL AND lease_until < now()
      )::int AS expired,
      count(*) FILTER (
        WHERE available_at > now() AND available_at <> 'infinity'
      )::int AS scheduled,
      count(*) FILTER (WHERE available_at = 'infinity')::int AS parked,
      max(extract(epoch FROM now() - available_at)) FILTER (
        WHERE available_at <= now()
          AND (lease_owner IS NULL OR lease_until < now())
      ) AS oldest_unprogressed_seconds
    FROM ${SCHEMA_NAME}.task
    WHERE $1::text IS NULL OR queue = $1::text
    `,
    [options.queue ?? null],
  );

  const row = (result.rows as QueueHealthRow[])[0];
  if (row === undefined) {
    return {
      oldestUnprogressedSeconds: null,
      claimable: 0,
      leased: 0,
      expired: 0,
      scheduled: 0,
      parked: 0,
    };
  }

  return {
    // `extract(epoch …)` is numeric, which node-postgres returns as a string
    // rather than lose precision.
    oldestUnprogressedSeconds:
      row.oldest_unprogressed_seconds === null
        ? null
        : Number(row.oldest_unprogressed_seconds),
    claimable: row.claimable,
    leased: row.leased,
    expired: row.expired,
    scheduled: row.scheduled,
    parked: row.parked,
  };
}

/**
 * Open runs that have stopped with a reason, counted by reason — the data
 * behind `cairn_run_stalled_total` in design doc §11.
 */
export async function stalledRunCounts(
  client: SqlExecutor,
): Promise<ReadonlyMap<string, number>> {
  const result = await client.query(
    `
    SELECT stall_reason, count(*)::int AS count
      FROM ${SCHEMA_NAME}.run
     WHERE stall_reason IS NOT NULL AND closed_at IS NULL
     GROUP BY stall_reason
     ORDER BY stall_reason
    `,
  );

  const rows = result.rows as { stall_reason: string; count: number }[];
  return new Map(rows.map((row) => [row.stall_reason, row.count]));
}

interface QueueHealthRow {
  claimable: number;
  leased: number;
  expired: number;
  scheduled: number;
  parked: number;
  oldest_unprogressed_seconds: string | null;
}

interface ClaimedTaskRow {
  id: string;
  run_id: string;
  queue: string;
  attempt: number;
  priority: number;
  fence: string;
  lease_until: Date;
}

interface RunRow {
  id: string;
  workflow_name: string;
  workflow_id: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: unknown;
  stall_reason: string | null;
  journal_len: number;
  created_at: Date;
  closed_at: Date | null;
  cancel_requested_at: Date | null;
  cancel_reason: string | null;
}

function leaseMilliseconds(leaseFor: Duration | undefined): number {
  const milliseconds = parseDuration(leaseFor ?? DEFAULT_LEASE);
  if (milliseconds <= 0) {
    throw new InvalidArgumentError("leaseFor must be greater than zero.");
  }
  return milliseconds;
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentError(`${name} must be a non-empty string.`);
  }
}
