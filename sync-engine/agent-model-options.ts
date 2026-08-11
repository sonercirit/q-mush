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

export interface AgentModelRequestOptions {
  readonly credential: AgentProviderCredential;
  readonly dynamicToolCache?: boolean;
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
