import { describe, expect, it } from "vitest";

import { InvalidStepNameError } from "../src/errors.js";
import {
  assertStepName,
  idempotencyKey,
  MAX_STEP_NAME_LENGTH,
  stepKey,
} from "../src/keys.js";

const RUN_A = "0196f1a0-0000-7000-8000-000000000001";
const RUN_B = "0196f1a0-0000-7000-8000-000000000002";

describe("stepKey", () => {
  it("joins the name and occurrence", () => {
    expect(stepKey("charge-card", 0)).toBe("charge-card#0");
    expect(stepKey("charge-card", 7)).toBe("charge-card#7");
  });

  it("is stable for the same inputs", () => {
    expect(stepKey("provision", 2)).toBe(stepKey("provision", 2));
  });

  it("rejects occurrences that are not non-negative integers", () => {
    expect(() => stepKey("a", -1)).toThrow(RangeError);
    expect(() => stepKey("a", 1.5)).toThrow(RangeError);
    expect(() => stepKey("a", Number.NaN)).toThrow(RangeError);
  });
});

describe("assertStepName", () => {
  it("accepts ordinary names", () => {
    expect(() => assertStepName("charge-card")).not.toThrow();
    expect(() => assertStepName("send email 2")).not.toThrow();
    expect(() => assertStepName("a".repeat(MAX_STEP_NAME_LENGTH))).not.toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => assertStepName("")).toThrow(InvalidStepNameError);
  });

  it("rejects a name over the length limit", () => {
    expect(() => assertStepName("a".repeat(MAX_STEP_NAME_LENGTH + 1))).toThrow(
      /over the 256 character limit/,
    );
  });

  it("rejects leading or trailing whitespace", () => {
    expect(() => assertStepName(" charge")).toThrow(/whitespace/);
    expect(() => assertStepName("charge ")).toThrow(/whitespace/);
  });

  // Keys are unambiguous even with `#` in a name, because the occurrence is
  // always appended last. The ban keeps every key splittable on a single
  // separator, which is a tidiness guarantee rather than a safety one.
  it("rejects the separator so that keys contain exactly one", () => {
    expect(() => stepKey("a#1", 0)).toThrow(InvalidStepNameError);
    expect(stepKey("a", 1)).toBe("a#1");
  });
});

describe("idempotencyKey", () => {
  it("returns 64 hex characters", () => {
    expect(idempotencyKey(RUN_A, "charge-card", 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls, so retries reuse it", () => {
    expect(idempotencyKey(RUN_A, "charge-card", 0)).toBe(
      idempotencyKey(RUN_A, "charge-card", 0),
    );
  });

  it("differs by run", () => {
    expect(idempotencyKey(RUN_A, "charge-card", 0)).not.toBe(
      idempotencyKey(RUN_B, "charge-card", 0),
    );
  });

  it("differs by step name and by occurrence", () => {
    const base = idempotencyKey(RUN_A, "charge-card", 0);
    expect(base).not.toBe(idempotencyKey(RUN_A, "provision", 0));
    expect(base).not.toBe(idempotencyKey(RUN_A, "charge-card", 1));
  });

  it("cannot be collided by shifting characters between run id and step name", () => {
    // Without the NUL separator, ("ab", "c") and ("a", "bc") would hash the
    // same concatenated string.
    expect(idempotencyKey("ab", "c", 0)).not.toBe(idempotencyKey("a", "bc", 0));
  });

  it("validates the step name", () => {
    expect(() => idempotencyKey(RUN_A, "bad#name", 0)).toThrow(InvalidStepNameError);
  });
});
