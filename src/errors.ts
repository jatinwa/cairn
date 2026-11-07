/**
 * Base class for every error this library raises.
 *
 * `name` is assigned explicitly in each subclass rather than derived from
 * `new.target`, so error types survive minification — they are matched by name
 * in retry policies (see `nonRetryable` in `./retry.js`).
 */
export class CairnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CairnError";
  }
}

/**
 * Thrown by user code inside a step to say "this will never succeed, do not
 * retry". The step fails immediately regardless of the retry policy.
 */
export class NonRetryableError extends CairnError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** A duration string that could not be parsed. */
export class InvalidDurationError extends CairnError {
  readonly input: string;

  constructor(input: string, reason: string) {
    super(`Invalid duration ${JSON.stringify(input)}: ${reason}.`);
    this.name = "InvalidDurationError";
    this.input = input;
  }
}

/** A step name that cannot be used to build a journal key. */
export class InvalidStepNameError extends CairnError {
  readonly stepName: string;

  constructor(stepName: string, reason: string) {
    super(`Invalid step name ${JSON.stringify(stepName)}: ${reason}.`);
    this.name = "InvalidStepNameError";
    this.stepName = stepName;
  }
}

/** A retry policy with contradictory or out-of-range values. */
export class InvalidRetryPolicyError extends CairnError {
  constructor(reason: string) {
    super(`Invalid retry policy: ${reason}.`);
    this.name = "InvalidRetryPolicyError";
  }
}

/**
 * The name a retry policy matches an error by, and the `type` recorded in a
 * journal entry. `Error.name` for errors, otherwise the `typeof` of whatever
 * was thrown — because `throw "boom"` is legal JavaScript.
 */
export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** An error reduced to something storable in a `jsonb` column. */
export interface SerialisedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Reduce a thrown value to a storable shape.
 *
 * `JSON.stringify(new Error("boom"))` is `{}` — `message` and `stack` are not
 * enumerable — so an error written straight to a `jsonb` column loses
 * everything that made it useful. Hence this.
 */
export function serialiseError(error: unknown): SerialisedError {
  if (error instanceof Error) {
    return { type: error.name, message: error.message, stack: error.stack };
  }
  return { type: typeof error, message: String(error) };
}

/** An argument to a public function was outside its contract. */
export class InvalidArgumentError extends CairnError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

/** A migration could not be loaded or applied. */
export class MigrationError extends CairnError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/**
 * An already-applied migration's file has changed since it ran. Editing a
 * migration that other databases have already applied leaves them silently
 * diverged, so this is always an error rather than a warning.
 */
export class MigrationChecksumError extends MigrationError {
  readonly version: string;

  constructor(version: string, expected: string, actual: string) {
    super(
      `Migration ${version} has already been applied, but its file has changed ` +
        `(recorded checksum ${expected}, file is now ${actual}). ` +
        `Add a new migration instead of editing an applied one.`,
    );
    this.name = "MigrationChecksumError";
    this.version = version;
  }
}
