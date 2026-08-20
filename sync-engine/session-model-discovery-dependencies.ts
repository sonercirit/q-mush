import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";

export interface SessionModelDiscoveryDependencies {
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
}

export interface RestartAwareSessionModelDiscoveryDependencies extends SessionModelDiscoveryDependencies {
  readonly restartSignal: () => AbortSignal;
}
