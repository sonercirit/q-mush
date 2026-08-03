import { expect, test } from "vitest";
import { summarizeTokenUsage } from "../session-token-usage.ts";

test("summarizes reported token usage without treating missing steps as zero", () => {
  expect(
    summarizeTokenUsage([
      {
        tokenUsage: {
          cacheWriteInputTokens: 50,
          cachedInputTokens: 600,
          inputTokens: 1_000,
          outputTokens: 200,
        },
      },
      { tokenUsage: null },
      {},
      {
        tokenUsage: {
          cacheWriteInputTokens: 25,
          cachedInputTokens: 300,
          inputTokens: 500,
          outputTokens: 100,
        },
      },
    ]),
  ).toEqual({
    cacheWriteInputTokens: 75,
    cachedInputTokens: 900,
    inputTokens: 1_500,
    outputTokens: 300,
    reportedStepCount: 2,
    stepCount: 4,
  });
});

test("returns no cache rate when reported steps have no input", () => {
  expect(
    summarizeTokenUsage([
      {
        tokenUsage: {
          cacheWriteInputTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 0,
          outputTokens: 12,
        },
      },
    ]),
  ).toMatchObject({ inputTokens: 0, reportedStepCount: 1, stepCount: 1 });
});
