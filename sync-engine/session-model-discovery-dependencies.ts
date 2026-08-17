import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";

export interface SessionModelDiscoveryDependencies {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
}

export interface RestartAwareSessionModelDiscoveryDependencies extends SessionModelDiscoveryDependencies {
  readonly restartSignal: () => AbortSignal;
}

export function selectDiscoveredModel(
  catalog: Awaited<ReturnType<AgentModelDiscoverer>>,
  modelId: string,
) {
  return catalog.models.find(({ id }) => id === modelId);
}

export function discoverCredentialModels(
  discover: AgentModelDiscoverer,
  provider: Parameters<AgentModelDiscoverer>[0],
  credential: ProviderCredentialAccess,
  signal?: AbortSignal,
) {
  return discover(provider, credential, signal);
}
