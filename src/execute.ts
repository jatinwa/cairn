import type { Duration } from "./duration.js";
import { readJournal } from "./journal.js";
import { resolveRetryPolicy } from "./retry.js";
import type { SqlExecutor } from "./sql.js";
import {
  closeRun,
  getRun,
  markRunRunning,
  parkRun,
  releaseTask,
  type ClaimedTask,
} from "./store.js";
import {
  executionStore,
  makeContext,
  type ExecutionState,
  type RegisteredWorkflow,
  type Suspension,
} from "./workflow.js";

export interface ExecuteDeps {
  readonly client: SqlExecutor;
  /** Workflow definitions by name, as a worker registers them. */
  readonly workflows: ReadonlyMap<string, RegisteredWorkflow>;
  readonly leaseFor?: Duration;
}

export type ExecutionOutcome =
  /** The workflow returned; the run is closed and its task removed. */
  | { readonly kind: "completed"; readonly output: unknown }
  /** The workflow threw; the run is closed as failed. */
  | { readonly kind: "failed"; readonly error: unknown }
  /** A durable sleep; the task is claimable again at `until`. */
  | { readonly kind: "sleeping"; readonly until: Date; readonly key: string }
  /** A step failed retryably; the task is claimable again after `delayMs`. */
  | {
      readonly kind: "retrying";
      readonly delayMs: number;
      readonly attempt: number;
      readonly key: string;
    }
  /** Another worker owns the run now. Nothing was touched. */
  | { readonly kind: "fenced" }
  /**
   * The engine's own bookkeeping failed, so nothing is known about the
   * workflow's progress. The run is left open and untouched; the lease will
   * expire and another worker will pick it up.
   */
  | { readonly kind: "abandoned"; readonly error: unknown }
  /** No worker here knows this workflow. The run is parked with a reason. */
  | { readonly kind: "unroutable"; readonly workflowName: string };

/**
 * Run one claimed task as far as it will go.
 *
 * The workflow function is executed from its first line every time. Steps
 * already in the journal return their recorded results without running, so the
 * function fast-forwards to the first thing it has not yet done, does that, and
 * carries on until it returns, throws, or suspends.
 *
 * The caller keeps the lease throughout and is responsible for heartbeating it;
 * this function does not. See design doc §7.3 for why the task is held rather
 * than handed back after every step.
 */
export async function executeTask(
  deps: ExecuteDeps,
  task: ClaimedTask,
): Promise<ExecutionOutcome> {
  const { client, workflows } = deps;

  const run = await getRun(client, task.runId);
  if (run === undefined || run.closedAt !== null) {
    return { kind: "fenced" };
  }

  const definition = workflows.get(run.workflowName);
  if (definition === undefined) {
    // Never retried into an infinite loop: parked, with a reason, for a human.
    await parkRun(client, task, "unroutable");
    return { kind: "unroutable", workflowName: run.workflowName };
  }

  await markRunRunning(client, task);

  let suspension: Suspension | undefined;
  let signalSuspended!: () => void;
  const suspended = new Promise<{ kind: "suspended" }>((resolve) => {
    signalSuspended = () => {
      resolve({ kind: "suspended" });
    };
  });

  const state: ExecutionState = {
    runId: task.runId,
    client,
    journal: await readJournal(client, task.runId),
    policy: resolveRetryPolicy(definition.retry),
    occurrences: new Map(),
    inFlight: new Map(),
    suspend: (next) => {
      if (suspension === undefined) {
        suspension = next;
        signalSuspended();
      }
    },
  };

  const context = makeContext(state, task.runId, run.workflowId, task.attempt);

  const settled = await Promise.race([
    executionStore
      .run(state, () =>
        // `as never` is the counterpart of RegisteredWorkflow's `never` input:
        // the registry cannot know each workflow's input type.
        definition.run(context, run.input as never),
      )
      .then(
        (output: unknown) => ({ kind: "returned" as const, output }),
        (error: unknown) => ({ kind: "threw" as const, error }),
      ),
    suspended,
  ]);

  // Checked before anything else, and read from the state rather than from the
  // thrown value: a workflow's own `try/catch` can swallow an EngineError, and
  // carrying on past a write that never landed would be far worse than
  // abandoning the attempt.
  if (state.engineFailure !== undefined) {
    return { kind: "abandoned", error: state.engineFailure };
  }

  if (settled.kind === "suspended") {
    return handleSuspension(deps, task, suspension!);
  }

  if (settled.kind === "returned") {
    const closed = await closeRun(client, task, {
      runId: task.runId,
      status: "completed",
      output: settled.output,
    });
    return closed ? { kind: "completed", output: settled.output } : { kind: "fenced" };
  }

  const closed = await closeRun(client, task, {
    runId: task.runId,
    status: "failed",
    error: settled.error,
  });
  return closed ? { kind: "failed", error: settled.error } : { kind: "fenced" };
}

async function handleSuspension(
  deps: ExecuteDeps,
  task: ClaimedTask,
  suspension: Suspension,
): Promise<ExecutionOutcome> {
  if (suspension.kind === "fenced") {
    return { kind: "fenced" };
  }

  if (suspension.kind === "sleep") {
    const released = await releaseTask(deps.client, task, {
      availableAt: suspension.until,
      attempt: 0,
    });
    return released
      ? { kind: "sleeping", until: suspension.until, key: suspension.key }
      : { kind: "fenced" };
  }

  const availableAt = new Date(Date.now() + suspension.delayMs);
  const released = await releaseTask(deps.client, task, {
    availableAt,
    attempt: suspension.attempt,
  });
  return released
    ? {
        kind: "retrying",
        delayMs: suspension.delayMs,
        attempt: suspension.attempt,
        key: suspension.key,
      }
    : { kind: "fenced" };
}
