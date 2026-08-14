import {
  readOpenRouterProviderRouting,
  type AgentReasoningEffort,
  type OpenRouterProviderRouting,
} from "../shared/agent-configuration.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export function agentModelOpenRouterProviderRouting(
  selection: string | null | undefined,
): OpenRouterProviderRouting | undefined {
  return readOpenRouterProviderRouting(selection);
}

export type AgentProviderCredential = Pick<
  ProviderCredentialAccess,
  "accountId" | "apiFormat" | "baseUrl" | "secret" | "source"
>;

// The one authoritative "does this session speak Anthropic Messages?"
// predicate: request building, discovery, and the lazy output-limit refresh
// must agree on it.
export function usesAnthropicFormat(
  provider: ProviderId,
  credential: Pick<AgentProviderCredential, "apiFormat">,
): boolean {
  return provider === "generic" && credential.apiFormat === "anthropic";
}

export interface AgentModelRequestOptions {
  readonly credential: AgentProviderCredential;
  readonly dynamicToolCache?: boolean;
  readonly maxOutputTokens: number | null;
  readonly model: string;
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly onStepStart?: () => void;
  readonly openRouterProviderRouting?: OpenRouterProviderRouting;
  readonly openRouterProviderTag?: string;
  readonly promptCacheKey?: string;
  readonly provider: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentSessionToolName[];
}
