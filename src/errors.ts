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
