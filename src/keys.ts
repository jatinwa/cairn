import { createHash } from "node:crypto";

import { InvalidStepNameError } from "./errors.js";

/**
 * Separates a step's name from its occurrence index in a journal key. Step
 * names may not contain it — see {@link assertStepName}.
 */
export const STEP_KEY_SEPARATOR = "#";

/** Matches the `step.key` column width in the schema. */
export const MAX_STEP_NAME_LENGTH = 256;

/**
 * Validate a step name.
 *
 * The `#` rule is not cosmetic. Journal keys are `name#occurrence`, so a name
 * containing `#` would make two different steps collide: `stepKey("a#1", 0)`
 * and `stepKey("a", 1)` would both be `"a#1"`, and the second step would read
 * the first one's recorded result instead of running.
 *
 * @throws {InvalidStepNameError}
 */
export function assertStepName(name: string): void {
  if (name.length === 0) {
    throw new InvalidStepNameError(name, "it is empty");
  }
  if (name.length > MAX_STEP_NAME_LENGTH) {
    throw new InvalidStepNameError(
      name,
      `it is ${name.length} characters, over the ${MAX_STEP_NAME_LENGTH} character limit`,
    );
  }
  if (name.includes(STEP_KEY_SEPARATOR)) {
    throw new InvalidStepNameError(
      name,
      `it contains ${JSON.stringify(STEP_KEY_SEPARATOR)}, which separates a step name from its occurrence index`,
    );
  }
  if (name !== name.trim()) {
    throw new InvalidStepNameError(name, "it has leading or trailing whitespace");
  }
}

/**
 * Build the journal key for the n-th occurrence of a step name within a run.
 *
 * Keys are name-based rather than positional, which is what lets a workflow
 * gain, lose or reorder steps without invalidating the journal of a run that is
 * already in flight.
 */
export function stepKey(name: string, occurrence: number): string {
  assertStepName(name);
  if (!Number.isInteger(occurrence) || occurrence < 0) {
    throw new RangeError(
      `Step occurrence must be a non-negative integer, received ${occurrence}.`,
    );
  }
  return `${name}${STEP_KEY_SEPARATOR}${occurrence}`;
}

/**
 * Derive the idempotency key a step should hand to a downstream service.
 *
 * Stable across retries of the same step (it does not include the attempt
 * number) and unique across runs. Returns 64 hex characters, which fits the
 * 255-character limit common to payment APIs.
 */
export function idempotencyKey(
  runId: string,
  name: string,
  occurrence: number,
): string {
  const key = stepKey(name, occurrence);
  // NUL separator: it cannot appear in a run id or a step name, so no pair of
  // distinct inputs can produce the same hashed string.
  return createHash("sha256").update(`${runId}\u0000${key}`).digest("hex");
}
