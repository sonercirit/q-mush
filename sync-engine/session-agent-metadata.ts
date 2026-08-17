import { optionalAbortSignal } from "../shared/abort-signal.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { SpawnSessionToolInput } from "./session-agent-tools.ts";
import { sessionMetadata } from "./session-provider-selection.ts";

interface SessionAgentMetadataDependencies {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
}

export async function discoverSessionAgentMetadata(
  dependencies: SessionAgentMetadataDependencies,
  input: SpawnSessionToolInput,
  credential: ProviderCredentialAccess,
  ownerId: string,
  rejectCredentialErrors: boolean,
  signal?: AbortSignal,
): Promise<
  Pick<
    AgentSessionDetail,
    | "adaptiveThinking"
    | "maxContextTokens"
    | "maxOutputTokens"
    | "providerPricing"
  >
> {
  const metadata = await sessionMetadata({
    credential,
    discoverModels: dependencies.discoverModels,
    discoverProviders: dependencies.discoverOpenRouterProviders,
    input,
    ownerId,
    rejectCredentialErrors,
    ...optionalAbortSignal(signal),
  });
  if ("error" in metadata) {
    throw new Error(
      metadata.error === "provider_unavailable"
        ? "The OpenRouter serving provider is unavailable"
        : "The OpenRouter serving provider could not be validated",
    );
  }
  return metadata;
}
