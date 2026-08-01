export const MODEL_PROVIDER_IDS = ["openai", "openrouter", "generic"] as const;

export type ProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return MODEL_PROVIDER_IDS.some((provider) => provider === value);
}
