import type {
  AgentReasoningEffort,
  OpenRouterProviderRouting,
} from "../shared/agent-configuration.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type {
  AgentSessionToolName,
  AgentToolDefinition,
} from "../shared/agent-tools.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { AgentProviderCredential } from "./agent-model-options.ts";

export type ProviderRequestProtocol =
  "anthropic" | "chat_completions" | "responses";

export interface ProviderModelRequest {
  readonly adaptiveThinking: boolean | null;
  readonly credential: AgentProviderCredential;
  readonly credentialFingerprint: string;
  readonly dynamicToolCache: boolean;
  readonly maxOutputTokens: number | null;
  readonly messages: readonly AgentConversationMessage[];
  readonly model: string;
  readonly openRouterProviderRouting: OpenRouterProviderRouting | undefined;
  readonly promptCacheKey: string | undefined;
  readonly protocol: ProviderRequestProtocol;
  readonly provider: ProviderId;
  readonly reasoningEffort: AgentReasoningEffort | undefined;
  readonly resolvedModel: string | undefined;
  readonly selectedTools: readonly AgentSessionToolName[];
  readonly stream: boolean;
  readonly systemPrompt: string;
  readonly tools: readonly AgentToolDefinition[];
}
