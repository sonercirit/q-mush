import type { ModelCredentialPool } from "./model-credential-pool.ts";
import type { OpenRouterProviderDiscoverer } from "./openrouter-provider-discovery.ts";
import type { RunnerIntegration } from "./runners.ts";
import { SessionAgentActions } from "./session-agent-actions.ts";
import { discoverSessionAgentMetadata } from "./session-agent-metadata.ts";
import { startManualSessionCompactionForUserId } from "./session-compaction-actions.ts";
import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionExecutionCleanup } from "./session-execution-cleanup.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

type AgentActionsDependencies = ConstructorParameters<
  typeof SessionAgentActions
>[0];

interface SessionAgentActionsResources extends Pick<
  AgentActionsDependencies,
  | "broker"
  | "database"
  | "discoverModels"
  | "notify"
  | "now"
  | "readCredential"
  | "store"
  | "withCredential"
> {
  readonly modelCredentialPool: ModelCredentialPool;
  readonly cleanup: SessionExecutionCleanup;
  readonly discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly launch: SessionLaunchBoundary["launch"];
  readonly requests: SessionRequestHelpers;
  readonly restartSignal: () => AbortSignal;
  readonly runnerIsAvailable: AgentActionsDependencies["runnerIsAvailable"];
  readonly runners: RunnerIntegration;
  readonly runtimes: SessionRuntimes;
}

export function createSessionAgentActions(
  resources: SessionAgentActionsResources,
): SessionAgentActions {
  return new SessionAgentActions({
    abortSession: resources.runtimes.abort.bind(resources.runtimes),
    activeSession: (id) => resources.runtimes.active(id),
    broker: resources.broker,
    browseDirectories: (request, signal) =>
      resources.requests.browseDirectories(request, signal),
    cleanupSession: (detail) => {
      void resources.cleanup.cleanupTerminal(detail);
    },
    compactSession: startManualSessionCompactionForUserId,
    database: resources.database,
    discoverModels: resources.discoverModels,
    discoverSessionMetadata: (
      input,
      credential,
      userId,
      rejectCredentialErrors,
      signal,
    ) =>
      discoverSessionAgentMetadata(
        {
          discoverModels: resources.discoverModels,
          discoverOpenRouterProviders: resources.discoverOpenRouterProviders,
        },
        input,
        credential,
        userId,
        rejectCredentialErrors,
        signal,
      ),
    launchSession: (credential, detail, userId, operation) =>
      resources.launch(detail, credential, userId, operation),
    listOnlineRunners: (userId, workspaceId) =>
      resources.runners.onlineForUser(userId, workspaceId),
    listRunnerOptions: (userId, request) =>
      resources.runners.listOnlineForUser(
        userId,
        {
          limit: request.limit,
          offset: request.offset,
          ...(request.search === undefined ? {} : { search: request.search }),
        },
        request.workspaceId,
      ),
    modelCredentialPool: resources.modelCredentialPool,
    notify: resources.notify,
    now: resources.now,
    pendingRestart: (runnerId) => resources.runtimes.pendingRestart(runnerId),
    readCredential: resources.readCredential,
    restartSignal: resources.restartSignal,
    runnerIsAvailable: resources.runnerIsAvailable,
    runtimes: resources.runtimes,
    settled: resources.runtimes.cleared.bind(resources.runtimes),
    store: resources.store,
    withCredential: resources.withCredential,
  });
}
