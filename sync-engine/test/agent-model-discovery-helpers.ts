import type {
  AgentModelCatalog,
  AgentModelOption,
  AgentReasoningEffort,
} from "../../shared/agent-configuration.ts";
import type {
  ProviderCredentialAccess,
  ProviderCredentialSource,
} from "../../shared/provider-credential-store.ts";
import type { ProviderModelPricing } from "../../shared/provider-model-pricing.ts";

export function credential(
  source: ProviderCredentialSource,
  secret: string,
  accountId: string | null = null,
  baseUrl?: string,
): ProviderCredentialAccess {
  return {
    accountId,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    id: "credential-id",
    isDefault: false,
    label: "Provider credential",
    secret,
    source,
  };
}

export function anthropicFormatCredential(): ProviderCredentialAccess {
  return {
    ...credential("api_key", "anthropic-secret"),
    apiFormat: "anthropic",
    baseUrl: "https://anthropic.example.test/v1",
  };
}

export function model(
  id: string,
  label: string,
  reasoningEfforts: readonly AgentReasoningEffort[],
  contextWindow: number | null = null,
  inputModalities: readonly string[] | null = null,
  outputModalities: readonly string[] | null = null,
  pricing: ProviderModelPricing | null = null,
): AgentModelOption {
  return {
    contextWindow,
    id,
    inputModalities,
    label,
    outputModalities,
    pricing,
    reasoningEfforts,
  };
}

export function catalog(
  defaultModel: string,
  models: readonly AgentModelOption[],
): AgentModelCatalog {
  return { defaultModel, models };
}
