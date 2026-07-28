export const DEFAULT_AUTO_RESET_THRESHOLD_PERCENT = 1;

export type ProviderQuotaResetOutcome =
  "already_redeemed" | "no_credit" | "nothing_to_reset" | "reset";

export interface ProviderQuotaSnapshot {
  readonly autoResetThresholdPercent: number;
  readonly bankedResetCount: number | null;
  readonly estimatedExhaustionAt: number | null;
  readonly remainingPercent: number | null;
  readonly resetSupported: boolean;
  readonly resetsAt: number | null;
  readonly source: string;
}

export interface ProviderQuotaResetResult {
  readonly outcome: ProviderQuotaResetOutcome;
  readonly quota: ProviderQuotaSnapshot;
  readonly replayed: boolean;
}
