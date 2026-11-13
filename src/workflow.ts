import { AsyncLocalStorage } from "node:async_hooks";

import { parseDuration, type Duration } from "./duration.js";
import { CairnError, EngineError } from "./errors.js";
import { beginStep, completeStep, failStep, type Journal } from "./journal.js";
import { idempotencyKey, stepKey } from "./keys.js";
import {
  resolveRetryPolicy,
  retryDelay,
  shouldRetry,
  type ResolvedRetryPolicy,
  type RetryPolicy,
} from "./retry.js";
import type { SqlExecutor } from "./sql.js";

export interface WorkflowContext {
  readonly runId: string;
  readonly workflowId: string;
  /** Attempts made on the current task, 0 on the first. */
  readonly attempt: number;
  /**
   * A key to hand a downstream service so it can reject a duplicate of this
   * step. Stable across retries, unique across runs. Call it inside the step
   * whose name it names.
   */
  idempotencyKey(name: string): string;
  /**
   * Aborts when the run has been asked to stop. Pass it to anything that
   * accepts one — `fetch`, a database driver — so a cancelled run stops at the
   * work it is doing rather than only between steps.
   */
  readonly signal: AbortSignal;
}

export type WorkflowFunction<Input = unknown, Output = unknown> = (
  ctx: WorkflowContext,
  input: Input,
) => Promise<Output>;

export interface WorkflowDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly run: WorkflowFunction<Input, Output>;
  /** Default retry policy for this workflow's steps. */
  readonly retry?: Partial<RetryPolicy>;
}

/**
 * A definition as the executor holds it. `never` as the input type is what
 * makes any concretely-typed definition assignable here: a function accepting
 * `MyInput` is assignable to one accepting `never`, since parameters are
 * contravariant.
 */
export type RegisteredWorkflow = WorkflowDefinition<never, unknown>;

export interface StepOptions {
  /** Overrides the workflow's retry policy for this step only. */
  readonly retry?: Partial<RetryPolicy>;
}

export function defineWorkflow<Input, Output>(
  name: string,
  run: WorkflowFunction<Input, Output>,
  options: { readonly retry?: Partial<RetryPolicy> } = {},
): WorkflowDefinition<Input, Output> {
  if (name.trim() === "") {
    throw new CairnError("A workflow name must not be empty.");
  }
  return { name, run, ...(options.retry === undefined ? {} : { retry: options.retry }) };
}

/**
 * Why the current attempt stopped running the workflow function.
 *
 * `sleep` and `retry` both mean "hand the task back, claimable at a later
 * moment". `fenced` means another worker has taken the run over and this
 * attempt must touch nothing further.
 */
export type Suspension =
  | { readonly kind: "sleep"; readonly until: Date; readonly key: string }
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly key: string;
      readonly attempt: number;
    }
  | { readonly kind: "fenced"; readonly key: string }
  /** The run was asked to stop, and execution has unwound to a safe point. */
  | { readonly kind: "cancelled"; readonly key: string };

export interface ExecutionState {
  readonly runId: string;
  readonly client: SqlExecutor;
  readonly journal: Journal;
  readonly policy: ResolvedRetryPolicy;
  /** How many times each step name has been reached in this attempt. */
  readonly occurrences: Map<string, number>;
  /** The occurrence currently executing per name, for `idempotencyKey`. */
  readonly inFlight: Map<string, number>;
  /** Aborted when this run has been asked to stop. */
  readonly signal: AbortSignal;
  suspend(suspension: Suspension): void;
  /**
   * Set when the engine's own bookkeeping failed. Recorded here rather than
   * only thrown, because a workflow's `try/catch` could otherwise swallow an
   * {@link EngineError} and let execution carry on past a write that never
   * landed. The executor checks this before interpreting anything else.
   */
  engineFailure?: unknown;
}

export const executionStore = new AsyncLocalStorage<ExecutionState>();

/**
 * A promise that never settles.
 *
 * This is how the engine suspends a workflow, and the choice matters. A thrown
 * sentinel would be caught by the workflow's own `try/catch` — the README's
 * example has one — and the engine's control flow would be swallowed by user
 * code. A promise that never resolves simply leaves the function parked at its
 * `await`, where nothing can intercept it.
 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // intentionally never settled
  });
}

function current(called: string): ExecutionState {
  const state = executionStore.getStore();
  if (state === undefined) {
    throw new CairnError(
      `${called}() was called outside a workflow. It only works inside a function passed to defineWorkflow().`,
    );
  }
  return state;
}

/**
 * Run one of the engine's own database calls, tagging any failure as an
 * {@link EngineError} and recording it on the state.
 */
async function engine<T>(
  state: ExecutionState,
  what: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (cause) {
    const failure = new EngineError(`cairn could not ${what}.`, { cause });
    state.engineFailure = failure;
    throw failure;
  }
}

function nextKey(state: ExecutionState, name: string): string {
  const occurrence = state.occurrences.get(name) ?? 0;
  state.occurrences.set(name, occurrence + 1);
  state.inFlight.set(name, occurrence);
  return stepKey(name, occurrence);
}

/**
 * Run `fn` at most once per run, durably.
 *
 * On a resume the recorded result is returned and `fn` is never called. On a
 * first pass `fn` runs, its result is recorded, and execution carries on. A
 * failure is retried per the policy; when the attempts run out the error is
 * thrown into the workflow, where the workflow's own `try/catch` may handle it.
 */
export async function step<T>(
  name: string,
  fn: () => T | Promise<T>,
  options: StepOptions = {},
): Promise<T> {
  const state = current("step");
  const key = nextKey(state, name);
  const recorded = state.journal.get(key);

  if (recorded?.status === "completed") {
    return recorded.output as T;
  }

  // Checked at the boundary as well as inside the step, so cancellation still
  // works for a step function that ignores the signal — it just takes effect
  // after that step rather than during it.
  if (state.signal.aborted) {
    state.suspend({ kind: "cancelled", key });
    return never<T>();
  }
  if (recorded?.status === "failed") {
    throw new CairnError(
      `Step ${key} failed permanently on an earlier attempt: ${describe(recorded.error)}`,
    );
  }

  const attempt = await engine(state, `open step ${key}`, () =>
    beginStep(state.client, { runId: state.runId, key }),
  );
  if (attempt === undefined) {
    // Completed by somebody else between our journal read and now, so we are
    // no longer the worker in charge of this run.
    state.suspend({ kind: "fenced", key });
    return never<T>();
  }

  const policy =
    options.retry === undefined
      ? state.policy
      : resolveRetryPolicy({ ...state.policy, ...options.retry });

  let output: T;
  try {
    output = await fn();
  } catch (error) {
    // A step that threw because it was aborted has not failed on its merits,
    // so it is not marked failed and not retried. The run is stopping.
    if (state.signal.aborted) {
      await engine(state, `record the interruption of ${key}`, () =>
        failStep(state.client, { runId: state.runId, key, error, permanent: false }),
      );
      state.suspend({ kind: "cancelled", key });
      return never<T>();
    }

    if (shouldRetry(error, policy, attempt)) {
      await engine(state, `record a retryable failure of ${key}`, () =>
        failStep(state.client, { runId: state.runId, key, error, permanent: false }),
      );
      state.suspend({
        kind: "retry",
        delayMs: retryDelay(policy, attempt),
        key,
        attempt,
      });
      return never<T>();
    }

    await engine(state, `record the failure of ${key}`, () =>
      failStep(state.client, { runId: state.runId, key, error, permanent: true }),
    );
    throw error;
  }

  await engine(state, `record the result of ${key}`, () =>
    completeStep(state.client, { runId: state.runId, key, output }),
  );
  return output;
}

/**
 * Wait, durably. The process may die and be replaced; the wait survives.
 *
 * The wake time is computed when the sleep is first reached and recorded in the
 * journal, so a resume neither waits again nor wakes early.
 */
export async function sleep(name: string, duration: Duration): Promise<void> {
  const state = current("sleep");
  const key = nextKey(state, name);
  const recorded = state.journal.get(key);

  if (recorded?.status === "completed") {
    return;
  }

  if (state.signal.aborted) {
    state.suspend({ kind: "cancelled", key });
    return never<void>();
  }

  const until = new Date(Date.now() + parseDuration(duration));
  const attempt = await engine(state, `open sleep ${key}`, () =>
    beginStep(state.client, { runId: state.runId, key }),
  );
  if (attempt === undefined) {
    return;
  }

  await engine(state, `record sleep ${key}`, () =>
    completeStep(state.client, {
      runId: state.runId,
      key,
      output: { until: until.toISOString() },
    }),
  );
  state.suspend({ kind: "sleep", until, key });
  return never<void>();
}

/** Build a {@link WorkflowContext} for an execution. */
export function makeContext(
  state: ExecutionState,
  runId: string,
  workflowId: string,
  attempt: number,
): WorkflowContext {
  return {
    runId,
    workflowId,
    attempt,
    signal: state.signal,
    idempotencyKey: (name) =>
      idempotencyKey(runId, name, state.inFlight.get(name) ?? 0),
  };
}

function describe(error: unknown): string {
  if (error !== null && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}
