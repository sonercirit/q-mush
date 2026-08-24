import type { AgentModelDiscoverer } from "./agent-model-discovery.ts";
import type { ModelCredentialPool } from "./model-credential-pool.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionCredentialReaders } from "./session-credential-readers.ts";
import type { SessionProviderUpdateDependencies } from "./session-provider-update.ts";
import type { SessionQuestionActionDependencies } from "./session-question-actions.ts";
import type { SessionQueueDependencies } from "./session-queue.ts";
import type { SessionStore } from "./session-store-interface.ts";
import type { SessionToolUpdateDependencies } from "./session-tool-update.ts";

export type RealtimeSessionCommandDependencies = SessionLaunchBoundary &
  Pick<SessionQueueDependencies, "runnerIsAvailable"> &
  Omit<RealtimeSessionCommandsOptions, "availability" | "lifecycle">;

export interface RealtimeSessionCommandsOptions {
  readonly actions: SessionAgentActions;
  readonly database: SessionToolUpdateDependencies["store"]["database"];
  readonly discoverModels: AgentModelDiscoverer;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly lifecycle: SessionLaunchBoundary;
  readonly modelCredentialPool: ModelCredentialPool;
  readonly providers: SessionCredentialReaders;
  readonly providerUpdates: Omit<
    SessionProviderUpdateDependencies,
    "discoverModels" | "discoverOpenRouterProviders" | "providers" | "store"
  >;
  readonly questions: SessionQuestionActionDependencies;
  readonly restartSignal: () => AbortSignal;
  readonly toolUpdates: Omit<
    SessionToolUpdateDependencies,
    "readCredentialSource" | "store"
  >;
  readonly availability: Pick<SessionQueueDependencies, "runnerIsAvailable">;
  readonly store: SessionStore;
}
