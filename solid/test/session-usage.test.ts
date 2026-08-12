import { expect, test } from "vitest";
import { sessionUsageText } from "../../solid/session-usage.ts";

const summary = {
  cacheWriteInputTokens: 75,
  cachedInputTokens: 900,
  inputTokens: 1_500,
  // 1,500 summed minus the 500-token final request leaves 1,000 tokens that
  // were available for caching.
  lastInputTokens: 500,
  outputTokens: 300,
  reportedStepCount: 2,
  stepCount: 4,
} as const;

test("formats aggregate usage and partial step coverage", () => {
  expect(sessionUsageText(summary)).toBe(
    "Input: 1.5K · Output: 300 · Cached: 900 · Cache write: 75 · Cache rate: 90% · 2 of 4 steps",
  );
});

test("caps the cache rate when shared prefixes exceed this session's", () => {
  expect(sessionUsageText({ ...summary, cachedInputTokens: 1_400 })).toContain(
    "Cache rate: 100%",
  );
});

test("omits cache rate when nothing was available for caching", () => {
  expect(
    sessionUsageText({
      ...summary,
      cachedInputTokens: 0,
      inputTokens: 500,
      lastInputTokens: 500,
      reportedStepCount: 1,
      stepCount: 1,
    }),
  ).not.toContain("Cache rate");
});
