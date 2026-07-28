import type { ProviderQuotaSnapshot } from "../provider-quota.ts";

export function unavailableQuotaExpectation(
  remainingPercent: number,
  resetsAt: number,
): Partial<ProviderQuotaSnapshot> {
  return {
    bankedResetCount: null,
    remainingPercent,
    resetSupported: false,
    resetsAt,
  };
}

export function codexUsageFixture(options: {
  readonly availableResetCount: number;
  readonly now: number;
  readonly remainingPercent: number;
}) {
  return {
    rate_limit: {
      primary_window: {
        limit_window_seconds: 18_000,
        reset_at: options.now / 1000 + 9000,
        used_percent: 100 - options.remainingPercent,
      },
    },
    rate_limit_reset_credits: {
      available_count: options.availableResetCount,
    },
  };
}
