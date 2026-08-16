import { createHash } from "node:crypto";
import {
  anthropicResolvedModel,
  type AnthropicReplayIdentityInput,
} from "./anthropic-replay-identity-input.ts";
import { normalizeGenericProviderBaseUrl } from "./generic-provider-url.ts";

export interface AnthropicReplayIdentity {
  readonly model: string;
  readonly provenance: string;
  readonly resolvedModel?: string;
}

export function anthropicReplayIdentityFrom(
  options: AnthropicReplayIdentityInput,
): AnthropicReplayIdentity {
  const { credential, credentialFingerprint, model, provider } = options;
  return {
    model,
    ...anthropicResolvedModel(options),
    provenance: createHash("sha256")
      .update(
        JSON.stringify([
          provider,
          credential.id,
          credential.apiFormat ??
            (provider === "generic" ? "openai" : provider),
          provider === "generic"
            ? (normalizeGenericProviderBaseUrl(credential.baseUrl) ?? "")
            : provider,
          credentialFingerprint,
        ]),
      )
      .digest("base64url"),
  };
}
