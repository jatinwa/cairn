import { parseDuration, type Duration } from "./duration.js";
import { InvalidRetryPolicyError, NonRetryableError } from "./errors.js";

export type JitterMode = "none" | "full";

export interface RetryPolicy {
  /** Total attempts, including the first. `1` means no retries. */
  readonly maxAttempts: number;
  /** Delay before the second attempt. */
  readonly initialInterval: Duration;
  /** Multiplier applied per attempt. `1` gives a constant delay. */
  readonly backoffCoefficient: number;
  /** Ceiling on the computed delay, applied before jitter. */
  readonly maxInterval: Duration;
  /**
   * `"full"` picks uniformly from `[0, delay]`. On by default: without it, a
   * downstream outage recovers into a synchronised retry spike from every
   * waiting run at once.
   */
  readonly jitter: JitterMode;
  /** Error type names that are never retried, matched against {@link errorType}. */
  readonly nonRetryable: readonly string[];
}

/** A {@link RetryPolicy} whose intervals have been parsed to milliseconds. */
export interface ResolvedRetryPolicy extends RetryPolicy {
  readonly initialInterval: number;
  readonly maxInterval: number;
}

export const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = Object.freeze({
  maxAttempts: 5,
  initialInterval: 1_000,
  backoffCoefficient: 2,
  maxInterval: 100_000,
  jitter: "full",
  nonRetryable: [],
});

/**
 * Fill in defaults, parse the intervals, and reject nonsense.
 *
 * @throws {InvalidRetryPolicyError}
 */
export function resolveRetryPolicy(
  overrides: Partial<RetryPolicy> = {},
): ResolvedRetryPolicy {
  const merged = { ...DEFAULT_RETRY_POLICY, ...overrides };

  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
    throw new InvalidRetryPolicyError(
      `maxAttempts must be an integer of at least 1, received ${merged.maxAttempts}`,
    );
  }
  if (!Number.isFinite(merged.backoffCoefficient) || merged.backoffCoefficient < 1) {
    throw new InvalidRetryPolicyError(
      `backoffCoefficient must be a finite number of at least 1, received ${merged.backoffCoefficient}`,
    );
  }
  if (merged.jitter !== "none" && merged.jitter !== "full") {
    throw new InvalidRetryPolicyError(
      `jitter must be "none" or "full", received ${JSON.stringify(merged.jitter)}`,
    );
  }

  return {
    ...merged,
    initialInterval: parseDuration(merged.initialInterval),
    maxInterval: parseDuration(merged.maxInterval),
    nonRetryable: [...merged.nonRetryable],
  };
}

/**
 * Milliseconds to wait before the attempt following `attempt`.
 *
 * `attempt` is 1-based and names the attempt that just failed, so the delay
 * before the second attempt is `retryDelay(policy, 1)`.
 *
 * `random` is injectable for tests. Using `Math.random` here is safe because
 * retry timing is engine-internal state, never part of a workflow's journal.
 */
export function retryDelay(
  policy: ResolvedRetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`Attempt must be an integer of at least 1, received ${attempt}.`);
  }

  // A large attempt count overflows to Infinity, which Math.min then clamps to
  // maxInterval — so there is no overflow case to special-case.
  const uncapped = policy.initialInterval * policy.backoffCoefficient ** (attempt - 1);
  const capped = Math.min(uncapped, policy.maxInterval);

  return Math.round(policy.jitter === "full" ? random() * capped : capped);
}

/**
 * The name a retry policy matches an error by. `Error.name` for errors,
 * otherwise the `typeof` of whatever was thrown.
 */
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Whether the policy permits retrying this error at all, ignoring attempt count. */
export function isRetryable(error: unknown, policy: ResolvedRetryPolicy): boolean {
  if (error instanceof NonRetryableError) {
    return false;
  }
  return !policy.nonRetryable.includes(errorType(error));
}

/**
 * Whether to retry after `attempt` failed with `error` — the combination of
 * {@link isRetryable} and the attempt budget.
 */
export function shouldRetry(
  error: unknown,
  policy: ResolvedRetryPolicy,
  attempt: number,
): boolean {
  if (attempt >= policy.maxAttempts) {
    return false;
  }
  return isRetryable(error, policy);
}
