import { describe, expect, test } from "vitest";
import { unavailableQuotaExpectation } from "../../shared/test/provider-quota-fixtures.ts";
import {
  readCodexQuota,
  readOpenAiKeyQuota,
  readOpenRouterQuota,
} from "../../sync-engine/provider-quota-parsers.ts";

const NOW = Date.UTC(2026, 6, 1, 12);

function expectUnavailableQuota(
  quota: ReturnType<typeof readOpenAiKeyQuota>,
  resetsAt: number,
  estimatedExhaustionAt: number | null,
): void {
  expect(quota).toMatchObject({
    ...unavailableQuotaExpectation(25, resetsAt),
    estimatedExhaustionAt,
  });
}

describe("provider quota parsing", () => {
  test("reads Codex windows, reset credits, and an exhaustion estimate", () => {
    const quota = readCodexQuota(
      {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 18_000,
            reset_at: (NOW + 9_000_000) / 1000,
            used_percent: 50,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            reset_at: (NOW + 453_600_000) / 1000,
            used_percent: 25,
          },
        },
        rate_limit_reset_credits: { available_count: 3 },
      },
      1,
      NOW,
    );

    expect(quota).toMatchObject({
      autoResetThresholdPercent: 1,
      bankedResetCount: 3,
      estimatedExhaustionAt: NOW + 9_000_000,
      remainingPercent: 50,
      resetSupported: true,
      resetsAt: NOW + 9_000_000,
    });
  });

  test("reads OpenAI request quota headers and their compound reset duration", () => {
    const quota = readOpenAiKeyQuota(
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "25",
        "x-ratelimit-reset-requests": "1h30m",
      }),
      1,
      NOW,
    );

    expectUnavailableQuota(quota, NOW + 5_400_000, null);
  });

  test("reads OpenRouter key credits and computes a monthly UTC reset", () => {
    const quota = readOpenRouterQuota(
      {
        data: {
          limit: 20,
          limit_remaining: 5,
          limit_reset: "monthly",
          usage: 15,
          usage_daily: 1,
          usage_monthly: 4,
          usage_weekly: 2,
        },
      },
      1,
      NOW,
    );

    expectUnavailableQuota(
      quota,
      Date.UTC(2026, 7, 1),
      NOW + (NOW - Date.UTC(2026, 6, 1)) / 3,
    );
  });
});
