import { describe, expect, it } from "vitest";

import { errorType, NonRetryableError, serialiseError } from "../src/errors.js";

describe("serialiseError", () => {
  // JSON.stringify(new Error("boom")) is "{}" — message and stack are not
  // enumerable — so writing an error straight to jsonb loses everything.
  it("keeps what JSON.stringify would throw away", () => {
    expect(JSON.stringify(new Error("boom"))).toBe("{}");

    const serialised = serialiseError(new Error("boom"));
    expect(serialised.type).toBe("Error");
    expect(serialised.message).toBe("boom");
    expect(serialised.stack).toContain("boom");
  });

  it("uses the error's own name as the type", () => {
    expect(serialiseError(new TypeError("bad")).type).toBe("TypeError");
    expect(serialiseError(new NonRetryableError("nope")).type).toBe("NonRetryableError");
  });

  it("survives a thrown non-error", () => {
    expect(serialiseError("boom")).toEqual({ type: "string", message: "boom" });
    expect(serialiseError(42)).toEqual({ type: "number", message: "42" });
    expect(serialiseError(null)).toEqual({ type: "object", message: "null" });
    expect(serialiseError(undefined)).toEqual({
      type: "undefined",
      message: "undefined",
    });
  });

  it("round-trips through JSON", () => {
    const parsed: unknown = JSON.parse(JSON.stringify(serialiseError(new Error("x"))));
    expect(parsed).toMatchObject({ type: "Error", message: "x" });
  });
});

describe("errorType", () => {
  it("agrees with serialiseError", () => {
    for (const thrown of [new TypeError("a"), "b", 3, null, undefined]) {
      expect(errorType(thrown)).toBe(serialiseError(thrown).type);
    }
  });
});
