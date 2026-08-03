import { expect, test } from "vitest";
import { sessionUsageText } from "../../solid/session-usage.ts";

const summary = {
  cacheWriteInputTokens: 75,
  cachedInputTokens: 900,
  inputTokens: 1_500,
  outputTokens: 300,
  reportedStepCount: 2,
  stepCount: 4,
} as const;

test("formats aggregate usage and partial step coverage", () => {
  expect(sessionUsageText(summary)).toBe(
    "Input: 1.5K · Output: 300 · Cached: 900 · Cache write: 75 · Cache rate: 60% · 2 of 4 steps",
  );
});

test("omits cache rate when reported steps have no input", () => {
  expect(
    sessionUsageText({
      ...summary,
      cachedInputTokens: 0,
      inputTokens: 0,
      reportedStepCount: 1,
      stepCount: 1,
    }),
  ).not.toContain("Cache rate");
});
