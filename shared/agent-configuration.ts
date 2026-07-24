import type {
  ProviderCredentialSource,
  ProviderId,
} from "./provider-credential-store.ts";
import type { ProviderModelPricing } from "./provider-model-pricing.ts";

// `ultra` is Codex client orchestration, not a provider reasoning value.
export const AGENT_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentReasoningEffort = (typeof AGENT_REASONING_EFFORTS)[number];

export interface AgentModelOption {
  readonly contextWindow: number | null;
  readonly id: string;
  readonly inputModalities: readonly string[] | null;
  readonly label: string;
  readonly outputModalities: readonly string[] | null;
  readonly pricing: ProviderModelPricing | null;
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
}

export interface AgentModelCatalog {
  readonly defaultModel: string | null;
  readonly models: readonly AgentModelOption[];
}

export interface OpenRouterProviderOption {
  readonly contextWindow: number | null;
  readonly name: string;
  readonly pricing: ProviderModelPricing | null;
  readonly tag: string;
}

export interface OpenRouterProviderCatalog {
  readonly providers: readonly OpenRouterProviderOption[];
}

const MODEL_PATTERN = /^[A-Za-z\d][A-Za-z\d._:/-]{0,199}$/u;

export function defaultAgentModel(
  provider: ProviderId,
  source: ProviderCredentialSource,
): string {
  if (provider === "openrouter") {
    return "openai/gpt-4.1-mini";
  }

  return source === "oauth" ? "gpt-5-codex" : "gpt-4.1-mini";
}

export function isAgentModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_PATTERN.test(value);
}

export function isOpenRouterProviderTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z\d][A-Za-z\d._:/-]{0,99}$/u.test(value)
  );
}

export function isAgentReasoningEffort(
  value: unknown,
): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.some((effort) => effort === value);
}

export function maximumAgentReasoningEffort(
  efforts: readonly AgentReasoningEffort[],
): AgentReasoningEffort | undefined {
  for (let index = AGENT_REASONING_EFFORTS.length - 1; index >= 0; index -= 1) {
    const effort = AGENT_REASONING_EFFORTS[index];

    if (effort !== undefined && efforts.includes(effort)) {
      return effort;
    }
  }

  return undefined;
}

export function reasoningEffortLabel(effort: AgentReasoningEffort): string {
  switch (effort) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra high";
    case "max":
      return "Maximum";
  }
}
