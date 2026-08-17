import { describe, expect, test } from "vitest";
import { MINIMUM_TOOL_OUTPUT_CHARACTERS } from "../../shared/tool-limits.ts";
import { unicodeCharacterCount } from "../../shared/tool-output-limits.ts";
import { boundSessionToolOutput } from "../session-tool-output.ts";

const SETTINGS = {
  executionLimitMinutes: 30,
  outputLimitCharacters: MINIMUM_TOOL_OUTPUT_CHARACTERS,
} as const;

describe("session tool output limit", () => {
  test("keeps an exact-boundary Unicode result unchanged", () => {
    const original = {
      output: "😀".repeat(MINIMUM_TOOL_OUTPUT_CHARACTERS),
      state: "completed" as const,
    };
    expect(boundSessionToolOutput(original, SETTINGS)).toBe(original);
  });

  test("adds the sole notice after raw runner overflow", () => {
    const result = boundSessionToolOutput(
      {
        output: "😀".repeat(MINIMUM_TOOL_OUTPUT_CHARACTERS + 1),
        state: "completed",
      },
      SETTINGS,
    );
    expect(unicodeCharacterCount(result.output)).toBe(
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
    );
    expect(result.output.match(/Tool output truncated/gu)).toHaveLength(1);
    expect(result.output).not.toContain("saved to");
  });
});
