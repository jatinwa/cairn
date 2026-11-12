import { randomUUID } from "node:crypto";

import { parseDuration, type Duration } from "./duration.js";
import { InvalidArgumentError } from "./errors.js";
import { executeTask, type ExecutionOutcome } from "./execute.js";
import type { SqlExecutor } from "./sql.js";
import {
  claimTasks,
  getRun,
  heartbeatTask,
  DEFAULT_CLAIM_LIMIT,
  DEFAULT_LEASE,
  type ClaimedTask,
  type RunRecord,
} from "./store.js";
import type { RegisteredWorkflow } from "./workflow.js";

export type WorkerEvent =
  | { readonly type: "claimed"; readonly count: number }
  | { readonly type: "idle" }
  | {
      readonly type: "finished";
      readonly task: ClaimedTask;
      readonly outcome: ExecutionOutcome;
    }
  /** `executeTask` itself threw — the lease is left to expire. */
  | { readonly type: "crashed"; readonly task: ClaimedTask; readonly error: unknown }
  /** A heartbeat was refused: this worker no longer owns the task. */
  | { readonly type: "lease-lost"; readonly task: ClaimedTask }
  /** The poll loop threw, usually because the database is unreachable. */
  | { readonly type: "poll-failed"; readonly error: unknown }
  | { readonly type: "stopped" };

export interface WorkerOptions {
  /**
   * A connection **pool**, or anything else that can run two queries at once.
   *
   * Not a single `pg` Client, even at `concurrency: 1`. The heartbeat for a
   * running task overlaps that task's own queries by design, so the worker
   * always has more than one query in flight. node-postgres queues overlapping
   * queries on a Client today, with a deprecation warning, and removes that
   * behaviour in pg@9.
   */
  readonly client: SqlExecutor;
  readonly workflows: readonly RegisteredWorkflow[];
  readonly queue?: string;
  /** Defaults to a fresh UUID. */
  readonly workerId?: string;
  /** Tasks executed at once. Default 1. */
  readonly concurrency?: number;
  /** How long a claim is held before another worker may take it. */
  readonly leaseFor?: Duration;
  /** How long to wait after an empty poll. Default 1 second. */
  readonly pollInterval?: Duration;
  /** Tasks claimed per poll. */
  readonly claimLimit?: number;
  readonly onEvent?: (event: WorkerEvent) => void;
}

export interface StopOptions {
  /**
   * Give up waiting for in-flight tasks after this long. Default 30 seconds.
   *
   * On timeout the worker stops waiting but does **not** release the tasks it
   * still holds. Releasing a task whose step is still running would let another
   * worker start the same work immediately, side effects and all. Leaving the
   * leases to expire is slower and correct.
   */
  readonly timeout?: Duration;
}

export interface Worker {
  readonly workerId: string;
  /** Begin polling. Calling it twice is a no-op. */
  start(): void;
  /** Stop polling and wait for in-flight tasks. Safe to call twice. */
  stop(options?: StopOptions): Promise<void>;
  /** Tasks currently executing. */
  readonly inFlight: number;
}

/**
 * Build a worker that claims tasks from a queue and runs them.
 *
 * Each in-flight task is heartbeated at a third of the lease interval, so a
 * step may take far longer than the lease without another worker stealing the
 * run. The lease exists to detect a *dead* worker, not a slow one.
 */
export function createWorker(options: WorkerOptions): Worker {
  const workflows = indexWorkflows(options.workflows);
  const workerId = options.workerId ?? randomUUID();
  const queue = options.queue ?? "default";
  const concurrency = positiveInteger(options.concurrency ?? 1, "concurrency");
  const claimLimit = positiveInteger(options.claimLimit ?? DEFAULT_CLAIM_LIMIT, "claimLimit");
  const leaseMs = positiveDuration(options.leaseFor ?? DEFAULT_LEASE, "leaseFor");
  const pollMs = positiveDuration(options.pollInterval ?? "1s", "pollInterval");
  const emit = options.onEvent ?? (() => undefined);

  const deps = {
    client: options.client,
    workflows,
    leaseFor: options.leaseFor ?? DEFAULT_LEASE,
  };

  const inFlight = new Set<string>();
  const drainWaiters: (() => void)[] = [];
  const timer = wakeableTimer();

  let running = false;
  let looping: Promise<void> | undefined;

  function settleDrain(): void {
    if (inFlight.size > 0) {
      return;
    }
    while (drainWaiters.length > 0) {
      drainWaiters.pop()?.();
    }
  }

  function drained(): Promise<void> {
    if (inFlight.size === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  async function run(task: ClaimedTask): Promise<void> {
    inFlight.add(task.taskId);

    // A third of the lease: two heartbeats may be lost before anyone else can
    // claim the task.
    const beat = setInterval(() => {
      void heartbeatTask(deps.client, task, deps.leaseFor)
        .then((held) => {
          if (!held) {
            emit({ type: "lease-lost", task });
          }
        })
        .catch(() => {
          // A failed heartbeat is indistinguishable from a slow one here; the
          // executor will discover the loss on its next write.
        });
    }, Math.max(50, Math.floor(leaseMs / 3)));

    try {
      const outcome = await executeTask(deps, task);
      emit({ type: "finished", task, outcome });
    } catch (error) {
      // Nothing is known about how far the run got, so the task is left alone
      // and its lease allowed to expire.
      emit({ type: "crashed", task, error });
    } finally {
      clearInterval(beat);
      inFlight.delete(task.taskId);
      settleDrain();
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const slots = concurrency - inFlight.size;
      if (slots <= 0) {
        await timer.wait(pollMs);
        continue;
      }

      let claimed: ClaimedTask[];
      try {
        claimed = await claimTasks(deps.client, {
          workerId,
          queue,
          leaseFor: deps.leaseFor,
          limit: Math.min(claimLimit, slots),
        });
      } catch (error) {
        // The database is unreachable or overloaded. Back off and try again
        // rather than spinning, and never let it end the loop.
        emit({ type: "poll-failed", error });
        await timer.wait(pollMs);
        continue;
      }

      if (claimed.length === 0) {
        emit({ type: "idle" });
        await timer.wait(pollMs);
        continue;
      }

      emit({ type: "claimed", count: claimed.length });
      for (const task of claimed) {
        void run(task);
      }
    }
  }

  return {
    workerId,

    get inFlight() {
      return inFlight.size;
    },

    start() {
      if (running) {
        return;
      }
      running = true;
      looping = loop();
    },

    async stop(stopOptions: StopOptions = {}) {
      running = false;
      timer.wake();
      await looping;
      looping = undefined;

      const timeoutMs = positiveDuration(stopOptions.timeout ?? "30s", "timeout");
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([
        drained(),
        new Promise<void>((resolve) => {
          giveUp = setTimeout(resolve, timeoutMs);
        }),
      ]);
      if (giveUp !== undefined) {
        clearTimeout(giveUp);
      }

      emit({ type: "stopped" });
    },
  };
}

/**
 * Poll until a run closes, then return it. Returns `undefined` if it is still
 * open when `timeout` elapses.
 *
 * Polling, not pushing: cutting dispatch latency with Postgres `LISTEN/NOTIFY`
 * is an open question in design doc §14, and it interacts with running
 * connections through PgBouncer in transaction mode.
 */
export async function waitForRun(
  client: SqlExecutor,
  runId: string,
  options: { readonly timeout?: Duration; readonly pollInterval?: Duration } = {},
): Promise<RunRecord | undefined> {
  const timeoutMs = positiveDuration(options.timeout ?? "30s", "timeout");
  const pollMs = positiveDuration(options.pollInterval ?? "100ms", "pollInterval");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const run = await getRun(client, runId);
    if (run !== undefined && run.closedAt !== null) {
      return run;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

/** A sleep that can be cut short, so stopping a worker is not slow. */
function wakeableTimer(): {
  wait(ms: number): Promise<void>;
  wake(): void;
} {
  let wake: (() => void) | undefined;
  return {
    wait(ms) {
      return new Promise<void>((resolve) => {
        const handle = setTimeout(() => {
          wake = undefined;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(handle);
          wake = undefined;
          resolve();
        };
      });
    },
    wake() {
      wake?.();
    },
  };
}

function indexWorkflows(
  definitions: readonly RegisteredWorkflow[],
): Map<string, RegisteredWorkflow> {
  const index = new Map<string, RegisteredWorkflow>();
  for (const definition of definitions) {
    if (index.has(definition.name)) {
      throw new InvalidArgumentError(
        `Two workflows are both named ${JSON.stringify(definition.name)}.`,
      );
    }
    index.set(definition.name, definition);
  }
  return index;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidArgumentError(
      `${name} must be an integer of at least 1, received ${value}.`,
    );
  }
  return value;
}

function positiveDuration(value: Duration, name: string): number {
  const milliseconds = parseDuration(value);
  if (milliseconds <= 0) {
    throw new InvalidArgumentError(`${name} must be greater than zero.`);
  }
  return milliseconds;
}
