import { describe, expect, test } from "vitest";
import {
  DEFAULT_TOOL_SETTINGS,
  formatToolLimitsStatement,
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  MINIMUM_TOOL_OUTPUT_CHARACTERS,
  readToolSettings,
} from "../tool-limits.ts";
import {
  boundToolResult,
  unicodeCharacterCount,
  unicodeCharacterPrefix,
} from "../tool-output-limits.ts";

function boundedOutput(output: string, outputLimitCharacters: number): string {
  return boundToolResult({ output }, { outputLimitCharacters }).output;
}

describe("tool settings", () => {
  test("uses the requested global defaults", () => {
    expect(DEFAULT_TOOL_SETTINGS).toEqual({
      executionLimitMinutes: 30,
      outputLimitCharacters: 20_000,
    });
  });

  test("allows the transport-derived output maximum", () => {
    expect(
      readToolSettings({
        executionLimitMinutes: MAXIMUM_TOOL_EXECUTION_MINUTES,
        outputLimitCharacters: MAXIMUM_TOOL_OUTPUT_CHARACTERS,
      }),
    ).toEqual({
      executionLimitMinutes: MAXIMUM_TOOL_EXECUTION_MINUTES,
      outputLimitCharacters: MAXIMUM_TOOL_OUTPUT_CHARACTERS,
    });
  });

  test("rejects values outside either authoritative range", () => {
    for (const value of [
      {},
      { executionLimitMinutes: 0, outputLimitCharacters: 20_000 },
      { executionLimitMinutes: 1.5, outputLimitCharacters: 20_000 },
      {
        executionLimitMinutes: MAXIMUM_TOOL_EXECUTION_MINUTES + 1,
        outputLimitCharacters: 20_000,
      },
      { executionLimitMinutes: 30, outputLimitCharacters: 1_999 },
      {
        executionLimitMinutes: 30,
        outputLimitCharacters: MAXIMUM_TOOL_OUTPUT_CHARACTERS + 1,
      },
      {
        executionLimitMinutes: 30,
        outputLimitCharacters: 20_000,
        unknown: true,
      },
    ]) {
      expect(readToolSettings(value)).toBeUndefined();
    }
  });

  test("rejects output limits too small to carry the truncation notice", () => {
    expect(
      readToolSettings({
        executionLimitMinutes: 30,
        outputLimitCharacters: MINIMUM_TOOL_OUTPUT_CHARACTERS - 1,
      }),
    ).toBeUndefined();
  });

  test("renders the configured values and sleep behavior once", () => {
    const statement = formatToolLimitsStatement({
      executionLimitMinutes: 7,
      outputLimitCharacters: 12_345,
    });
    expect(statement).toContain("7 minutes");
    expect(statement).toContain("12,345 Unicode characters");
    expect(statement).toContain("including sleep");
    expect(statement.match(/7 minutes/gu)).toHaveLength(1);
  });
});

describe("model-facing tool output bound", () => {
  test("counts Unicode code points rather than UTF-8 bytes or UTF-16 units", () => {
    expect(unicodeCharacterCount("A😀é")).toBe(3);
    expect(unicodeCharacterPrefix("A😀é", 2)).toBe("A😀");
  });

  test("keeps output unchanged at the exact boundary", () => {
    expect(boundedOutput("😀é", 2)).toBe("😀é");
  });

  test("reserves space for one notice and stays inside the character limit", () => {
    const maximum = 120;
    const bounded = boundedOutput("😀".repeat(200), maximum);
    expect(unicodeCharacterCount(bounded)).toBe(maximum);
    expect(bounded.match(/Tool output truncated/gu)).toHaveLength(1);
  });

  test("uses the minimum budget without splitting emoji and keeps its notice", () => {
    const bounded = boundedOutput(
      "😀".repeat(MINIMUM_TOOL_OUTPUT_CHARACTERS + 1),
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
    );
    expect(unicodeCharacterCount(bounded)).toBe(MINIMUM_TOOL_OUTPUT_CHARACTERS);
    expect(bounded).toContain("Tool output truncated");
    expect(bounded).not.toContain("�");
  });
});
