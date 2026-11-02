import { describe, expect, it } from "vitest";

import { parseDuration } from "../src/duration.js";
import { InvalidDurationError } from "../src/errors.js";

describe("parseDuration", () => {
  it("passes numbers through as milliseconds", () => {
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration(1500)).toBe(1500);
  });

  it("rounds fractional milliseconds", () => {
    expect(parseDuration(1.4)).toBe(1);
    expect(parseDuration("0.0015s")).toBe(2);
  });

  it.each([
    ["1ms", 1],
    ["250 milliseconds", 250],
    ["30s", 30_000],
    ["30 seconds", 30_000],
    ["5m", 300_000],
    ["5 minutes", 300_000],
    ["2h", 7_200_000],
    ["2 hours", 7_200_000],
    ["14 days", 1_209_600_000],
    ["1d", 86_400_000],
    ["3w", 1_814_400_000],
  ])("parses %s", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("accumulates compound terms", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1d 12h")).toBe(129_600_000);
    expect(parseDuration("1m 30s 500ms")).toBe(90_500);
  });

  it("ignores surrounding whitespace and case", () => {
    expect(parseDuration("  14 DAYS  ")).toBe(1_209_600_000);
    expect(parseDuration("30S")).toBe(30_000);
  });

  it("accepts decimal amounts", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace only"],
    ["14", "no unit"],
    ["days", "no amount"],
    ["14 days please", "trailing junk"],
    ["-5s", "negative"],
    ["14 parsecs", "unknown unit"],
  ])("rejects %s (%s)", (input) => {
    expect(() => parseDuration(input)).toThrow(InvalidDurationError);
  });

  it.each(["1 month", "2 months", "1y", "3 years"])(
    "refuses the variable-length unit in %s",
    (input) => {
      expect(() => parseDuration(input)).toThrow(/varies in length/);
    },
  );

  it("rejects negative and non-finite numbers", () => {
    expect(() => parseDuration(-1)).toThrow(InvalidDurationError);
    expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(InvalidDurationError);
    expect(() => parseDuration(Number.NaN)).toThrow(InvalidDurationError);
  });

  it("rejects values beyond the safe integer range", () => {
    expect(() => parseDuration("999999999999 days")).toThrow(/safe integer/);
  });

  it("is reusable — the global regex does not leak state between calls", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("30s")).toBe(30_000);
  });
});
