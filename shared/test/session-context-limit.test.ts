import { describe, expect, test } from "vitest";
import {
  contextTokenCapValidationError,
  effectiveContextTokenLimit,
  parseContextTokenCapInput,
} from "../session-context-limit.ts";

describe("session context token caps", () => {
  test("uses the lower user cap as the effective limit", () => {
    expect(effectiveContextTokenLimit(200_000, 120_000)).toBe(120_000);
    expect(effectiveContextTokenLimit(100_000, 120_000)).toBe(100_000);
    expect(effectiveContextTokenLimit(null, 120_000)).toBe(120_000);
    expect(effectiveContextTokenLimit(200_000, null)).toBe(200_000);
    expect(effectiveContextTokenLimit(null, null)).toBeNull();
  });

  test("parses blank and positive integer form values", () => {
    expect(parseContextTokenCapInput("")).toBeNull();
    expect(parseContextTokenCapInput(" 120000 ")).toBe(120_000);
    expect(parseContextTokenCapInput("0")).toBeUndefined();
    expect(parseContextTokenCapInput("1.5")).toBeUndefined();
  });

  test("validates positive integer caps against a known model limit", () => {
    expect(contextTokenCapValidationError(120_000, 200_000)).toBeUndefined();
    expect(contextTokenCapValidationError(null, 200_000)).toBeUndefined();
    expect(contextTokenCapValidationError(0, 200_000)).toBe(
      "Context token cap must be a positive integer.",
    );
    expect(contextTokenCapValidationError(1.5, 200_000)).toBe(
      "Context token cap must be a positive integer.",
    );
    expect(contextTokenCapValidationError(200_001, 200_000)).toBe(
      "Context token cap cannot exceed the model limit of 200,000 tokens.",
    );
    expect(contextTokenCapValidationError(200_001, null)).toBeUndefined();
  });
});
