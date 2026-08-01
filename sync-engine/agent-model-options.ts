import {
  readOpenRouterProviderRouting,
  type AgentReasoningEffort,
  type OpenRouterProviderRouting,
} from "../shared/agent-configuration.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type {
  ProviderCredentialSource,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export function agentModelOpenRouterProviderRouting(
  selection: string | null | undefined,
): OpenRouterProviderRouting | undefined {
  return readOpenRouterProviderRouting(selection);
}

export interface AgentProviderCredential {
  readonly accountId: string | null;
  readonly baseUrl?: string;
  readonly secret: string;
  readonly source: ProviderCredentialSource;
}

export interface AgentModelRequestOptions {
  readonly credential: AgentProviderCredential;
  readonly dynamicToolCache?: boolean;
  readonly model: string;
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly onStepStart?: () => void;
  readonly openRouterProviderRouting?: OpenRouterProviderRouting;
  readonly openRouterProviderTag?: string;
  readonly provider: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentSessionToolName[];
}
