import type {
  ProviderCredentialSource,
  ProviderId,
} from "./provider-credential-store.ts";

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
  readonly id: string;
  readonly label: string;
  readonly reasoningEfforts: readonly AgentReasoningEffort[];
}

export interface AgentModelCatalog {
  readonly defaultModel: string | null;
  readonly models: readonly AgentModelOption[];
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

export function isAgentReasoningEffort(
  value: unknown,
): value is AgentReasoningEffort {
  return AGENT_REASONING_EFFORTS.some((effort) => effort === value);
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
