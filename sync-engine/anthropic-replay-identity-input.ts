import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { AgentProviderCredential } from "./agent-model-options.ts";

export interface AnthropicReplayIdentityInput {
  readonly credential: AgentProviderCredential;
  readonly credentialFingerprint: string;
  readonly model: string;
  readonly provider: ProviderId;
  readonly resolvedModel?: string | undefined;
}

export function anthropicResolvedModel(options: {
  readonly resolvedModel?: string | undefined;
}): { readonly resolvedModel?: string } {
  return options.resolvedModel === undefined
    ? {}
    : { resolvedModel: options.resolvedModel };
}

export function anthropicReplayIdentityInput(
  options: AnthropicReplayIdentityInput,
): AnthropicReplayIdentityInput {
  return { ...options, ...anthropicResolvedModel(options) };
}
