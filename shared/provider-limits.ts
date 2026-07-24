import type { ProviderId } from "./provider-credential-store.ts";

const PROVIDER_LIMIT_STALE_AFTER_MILLISECONDS = 15 * 60 * 1000;

export type ProviderLimitSource =
  "credential_metadata" | "http_headers" | "response_event" | "websocket_event";

export type ProviderLimitUnit = "credits" | "percent" | "requests" | "tokens";

export interface ProviderLimitDimension {
  readonly key: string;
  readonly label: string;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: number | null;
  readonly unit: ProviderLimitUnit;
  readonly used?: number | null;
}

export interface ProviderLimitObservation {
  readonly dimensions: readonly ProviderLimitDimension[];
  readonly observedAt: number;
  readonly provider: ProviderId;
  readonly source: ProviderLimitSource;
}

interface AvailableProviderLimits extends ProviderLimitObservation {
  readonly stale: boolean;
  readonly status: "available";
}

export type ProviderLimitState =
  { readonly status: "unavailable" } | AvailableProviderLimits;

export function providerLimitState(
  observation: ProviderLimitObservation | null,
  now: number,
): ProviderLimitState {
  if (observation === null) {
    return { status: "unavailable" };
  }

  return {
    ...observation,
    stale:
      now < observation.observedAt ||
      now - observation.observedAt > PROVIDER_LIMIT_STALE_AFTER_MILLISECONDS,
    status: "available",
  };
}
