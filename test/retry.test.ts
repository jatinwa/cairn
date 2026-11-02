import { describe, expect, it } from "vitest";

import { InvalidRetryPolicyError, NonRetryableError } from "../src/errors.js";
import {
  DEFAULT_RETRY_POLICY,
  errorType,
  isRetryable,
  resolveRetryPolicy,
  retryDelay,
  shouldRetry,
} from "../src/retry.js";

const noJitter = resolveRetryPolicy({ jitter: "none" });

describe("resolveRetryPolicy", () => {
  it("defaults to five attempts with full jitter", () => {
    const policy = resolveRetryPolicy();
    expect(policy).toEqual(DEFAULT_RETRY_POLICY);
    expect(policy.jitter).toBe("full");
  });

  it("parses string intervals to milliseconds", () => {
    const policy = resolveRetryPolicy({ initialInterval: "2s", maxInterval: "5m" });
    expect(policy.initialInterval).toBe(2_000);
    expect(policy.maxInterval).toBe(300_000);
  });

  it("copies nonRetryable so the caller's array cannot mutate the policy", () => {
    const nonRetryable = ["ValidationError"];
    const policy = resolveRetryPolicy({ nonRetryable });
    nonRetryable.push("OtherError");
    expect(policy.nonRetryable).toEqual(["ValidationError"]);
  });

  it.each([
    [{ maxAttempts: 0 }, /maxAttempts/],
    [{ maxAttempts: 1.5 }, /maxAttempts/],
    [{ backoffCoefficient: 0.5 }, /backoffCoefficient/],
    [{ backoffCoefficient: Number.POSITIVE_INFINITY }, /backoffCoefficient/],
  ])("rejects %o", (overrides, pattern) => {
    expect(() => resolveRetryPolicy(overrides)).toThrow(InvalidRetryPolicyError);
    expect(() => resolveRetryPolicy(overrides)).toThrow(pattern);
  });

  it("rejects an unknown jitter mode", () => {
    expect(() =>
      resolveRetryPolicy({ jitter: "some" as unknown as "full" }),
    ).toThrow(InvalidRetryPolicyError);
  });
});

describe("retryDelay", () => {
  it("doubles from the initial interval with the default coefficient", () => {
    expect(retryDelay(noJitter, 1)).toBe(1_000);
    expect(retryDelay(noJitter, 2)).toBe(2_000);
    expect(retryDelay(noJitter, 3)).toBe(4_000);
    expect(retryDelay(noJitter, 4)).toBe(8_000);
  });

  it("caps at maxInterval", () => {
    expect(retryDelay(noJitter, 10)).toBe(noJitter.maxInterval);
  });

  it("does not overflow at absurd attempt counts", () => {
    expect(retryDelay(noJitter, 2_000)).toBe(noJitter.maxInterval);
  });

  it("is constant when the coefficient is 1", () => {
    const flat = resolveRetryPolicy({ jitter: "none", backoffCoefficient: 1 });
    expect(retryDelay(flat, 1)).toBe(1_000);
    expect(retryDelay(flat, 5)).toBe(1_000);
  });

  describe("full jitter", () => {
    const policy = resolveRetryPolicy({ jitter: "full" });

    it("spans the whole window", () => {
      expect(retryDelay(policy, 3, () => 0)).toBe(0);
      expect(retryDelay(policy, 3, () => 1)).toBe(4_000);
      expect(retryDelay(policy, 3, () => 0.5)).toBe(2_000);
    });

    it("never exceeds the undelayed value", () => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const jittered = retryDelay(policy, attempt);
        expect(jittered).toBeGreaterThanOrEqual(0);
        expect(jittered).toBeLessThanOrEqual(retryDelay(noJitter, attempt));
      }
    });

    it("actually varies, so an outage does not recover into a spike", () => {
      const samples = new Set(
        Array.from({ length: 50 }, () => retryDelay(policy, 5)),
      );
      expect(samples.size).toBeGreaterThan(1);
    });
  });

  it("rejects attempts below one", () => {
    expect(() => retryDelay(noJitter, 0)).toThrow(RangeError);
    expect(() => retryDelay(noJitter, -1)).toThrow(RangeError);
    expect(() => retryDelay(noJitter, 1.5)).toThrow(RangeError);
  });
});

describe("errorType", () => {
  it("uses Error.name", () => {
    expect(errorType(new TypeError("boom"))).toBe("TypeError");
    expect(errorType(new NonRetryableError("boom"))).toBe("NonRetryableError");
  });

  it("falls back to typeof for non-errors", () => {
    expect(errorType("boom")).toBe("string");
    expect(errorType(undefined)).toBe("undefined");
  });
});

describe("isRetryable", () => {
  it("retries ordinary errors", () => {
    expect(isRetryable(new Error("boom"), noJitter)).toBe(true);
  });

  it("never retries NonRetryableError, whatever the policy says", () => {
    const permissive = resolveRetryPolicy({ nonRetryable: [] });
    expect(isRetryable(new NonRetryableError("nope"), permissive)).toBe(false);
  });

  it("honours the nonRetryable list by error name", () => {
    const policy = resolveRetryPolicy({ nonRetryable: ["TypeError"] });
    expect(isRetryable(new TypeError("boom"), policy)).toBe(false);
    expect(isRetryable(new RangeError("boom"), policy)).toBe(true);
  });
});

describe("shouldRetry", () => {
  const policy = resolveRetryPolicy({ maxAttempts: 3 });

  it("retries while attempts remain", () => {
    expect(shouldRetry(new Error("boom"), policy, 1)).toBe(true);
    expect(shouldRetry(new Error("boom"), policy, 2)).toBe(true);
  });

  it("stops at the attempt budget", () => {
    expect(shouldRetry(new Error("boom"), policy, 3)).toBe(false);
    expect(shouldRetry(new Error("boom"), policy, 4)).toBe(false);
  });

  it("stops immediately for a non-retryable error", () => {
    expect(shouldRetry(new NonRetryableError("nope"), policy, 1)).toBe(false);
  });

  it("treats maxAttempts of 1 as no retries", () => {
    const once = resolveRetryPolicy({ maxAttempts: 1 });
    expect(shouldRetry(new Error("boom"), once, 1)).toBe(false);
  });
});
