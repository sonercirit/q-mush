import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type {
  ProviderCredentialSource,
  ProviderId,
} from "../shared/provider-credential-store.ts";

export interface SessionToolCacheCapabilityInput {
  readonly credentialSource: ProviderCredentialSource;
  readonly provider: ProviderId;
  readonly tools: readonly AgentSessionToolName[];
}

export interface SessionToolCacheCapability {
  readonly preservesDynamicToolCache: boolean;
  readonly strategy: "openai_allowed_tools" | "replace_tool_definitions";
}

/**
 * OpenAI documents `allowed_tools` as the dynamic subset mechanism that keeps
 * the complete tool-definition prefix stable for prompt caching. Q Mush uses
 * Responses only for its OpenAI OAuth/Codex transport, so API-key chat
 * completions and OpenRouter remain warning-required rather than inferred.
 * `parallel` embeds the selected recipient enum in its schema, so arbitrary
 * parallel subsets also warn instead of claiming the definition prefix stable.
 */
export function sessionToolCacheCapability(
  input: SessionToolCacheCapabilityInput,
): SessionToolCacheCapability {
  const parallelSchemaIsStable =
    !input.tools.includes("parallel") ||
    (input.tools.length === AGENT_SESSION_TOOL_NAMES.length &&
      AGENT_SESSION_TOOL_NAMES.every((name) => input.tools.includes(name)));
  const preserves =
    input.provider === "openai" &&
    input.credentialSource === "oauth" &&
    parallelSchemaIsStable;
  return preserves
    ? {
        preservesDynamicToolCache: true,
        strategy: "openai_allowed_tools",
      }
    : {
        preservesDynamicToolCache: false,
        strategy: "replace_tool_definitions",
      };
}
