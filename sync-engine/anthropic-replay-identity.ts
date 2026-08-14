import { createHash } from "node:crypto";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { AgentProviderCredential } from "./agent-model-options.ts";
import { normalizeGenericProviderBaseUrl } from "./generic-provider-url.ts";

export interface AnthropicReplayIdentity {
  readonly model: string;
  readonly provenance: string;
}

export function anthropicReplayIdentity(
  provider: ProviderId,
  credential: AgentProviderCredential,
  model: string,
  credentialFingerprint: string,
): AnthropicReplayIdentity {
  return {
    model,
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
