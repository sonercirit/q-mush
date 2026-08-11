export const MODEL_PROVIDER_IDS = ["openai", "openrouter", "generic"] as const;

export type ProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return MODEL_PROVIDER_IDS.some((provider) => provider === value);
}

export const PROVIDER_API_FORMATS = ["openai", "anthropic"] as const;

export type ProviderApiFormat = (typeof PROVIDER_API_FORMATS)[number];

export function isProviderApiFormat(
  value: unknown,
): value is ProviderApiFormat {
  return PROVIDER_API_FORMATS.some((format) => format === value);
}
