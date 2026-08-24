import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { RestartHandoffOperation } from "../shared/session-model.ts";
import { createActiveSessionTools } from "./active-session-tools.ts";
import { discoverAgentModels } from "./agent-model-discovery.ts";
import { ChatCompletionsAgentModel } from "./agent-model.ts";
import { createAttachmentFallbackIntegration } from "./attachment-fallback-integration.ts";
import type { GoogleAuth } from "./auth.ts";
import { ModelCredentialPool } from "./model-credential-pool.ts";
import { discoverOpenRouterProviders } from "./openrouter-provider-discovery.ts";
import type { RunnerIntegration } from "./runners.ts";
import { createConfiguredSessionAgentActions } from "./session-agent-actions-factory.ts";
import {
  startManualSessionCompactionForUserId,
  type ManualCompactionDependencies,
} from "./session-compaction-actions.ts";
import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionCredentialReaders } from "./session-credential-access.ts";
import { createSessionCredentialAccess } from "./session-credential-service.ts";
import {
  permissiveWorkspaceReader,
  type SessionDependencies,
} from "./session-dependencies.ts";
import { createSessionExecutionCleanup } from "./session-execution-cleanup.ts";
import { createSessionFailureReconciler } from "./session-failure-reconciler.ts";
import { createSessionFinisher } from "./session-finisher.ts";
import { compactIdleSessions } from "./session-idle-compaction.ts";
import {
  SessionIntegrationApi,
  type SessionIntegrationApiResources,
} from "./session-integration-api.ts";
import type { SessionIntegrationFactory } from "./session-integration-factory.ts";
import type { SessionIntegration } from "./session-integration.ts";
import {
  recoverInterruptedSessions,
  reportPendingSpawns,
} from "./session-interrupted-recovery.ts";
import { createSessionLauncher } from "./session-launcher.ts";
import { createSessionLivenessWatchdog } from "./session-liveness-scheduler.ts";
import { modelsForUser } from "./session-model-discovery.ts";
import { recoverAnsweredQuestions } from "./session-question-actions.ts";
import { launchAnsweredQuestionSession } from "./session-question-launcher.ts";
import { launchQueuedSessions } from "./session-queued-launcher.ts";
import { createRealtimeSessionCommands } from "./session-realtime-factory.ts";
import { createSessionRequestHelpers } from "./session-request-helpers.ts";
import { createSessionRestartAbort } from "./session-restart-abort.ts";
import { createSessionRestartControl } from "./session-restart-control.ts";
import { createSessionRestartCoordinator } from "./session-restart-coordinator.ts";
import { createRunnerRemovalCoordinator } from "./session-runner-removal.ts";
import { createSessionRuntimes } from "./session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import type { SpawnedReportDisposition } from "./session-store-spawns.ts";
import { createSessionStore } from "./session-store.ts";
import {
  compactSessionForUser,
  createSessionForUser,
  queueSessionPromptForUser,
} from "./session-user-actions.ts";
import { createToolSettingsStore } from "./tool-settings-store.ts";

export type { SessionIntegration } from "./session-integration.ts";

export interface DrizzleSessionIntegration extends SessionIntegration {
  abortAgentActionsForRestart(): void;
  agentActionsDraining(): boolean;
}

function createDrizzleSessionIntegration(
  authInput: GoogleAuth,
  runnersInput: RunnerIntegration,
  providersInput: SessionCredentialReaders,
  dependencies: SessionDependencies,
): DrizzleSessionIntegration {
  const onChange = new Set<(userId: string, sessionId: string) => void>();
  const failureReconciler = createSessionFailureReconciler();
  const restartController = createSessionRestartAbort();

  const auth = authInput;
  const activeTools = dependencies.activeTools ?? createActiveSessionTools();
  const realtime = dependencies.realtime;
  const broker =
    dependencies.broker ??
    new RunnerCommandBroker({
      cancel: (runnerId, commandId) =>
        realtime?.publishRunnerCancellation(runnerId, commandId),
      deliver: (runnerId, command) =>
        realtime?.publishRunnerCommand(runnerId, command) === true,
    });
  const braveSearch = dependencies.braveSearch;
  const database = dependencies.database ?? createDatabase(":memory:");
  const models = dependencies.discoverModels ?? discoverAgentModels;
  const discoverProviders =
    dependencies.discoverOpenRouterProviders ?? discoverOpenRouterProviders;
  const modelFactory =
    dependencies.modelFactory ??
    ((options) => new ChatCompletionsAgentModel(options));
  const now = dependencies.now ?? Date.now;
  const runtimes = createSessionRuntimes(now);
  const providers = providersInput;
  const credentials = createSessionCredentialAccess(providers);
  const readCredential: typeof credentials.read = (...parameters) =>
    credentials.read(...parameters);
  const withCredential: typeof credentials.with = (...parameters) =>
    credentials.with(...parameters);
  const credentialPool = new ModelCredentialPool({
    database,
    readCredential: readCredential,
  });
  const workspaces = dependencies.workspaces ?? permissiveWorkspaceReader;
  const requests = createSessionRequestHelpers(auth, broker, runnersInput);
  const runners = runnersInput;
  const reportParent = (
    userId: string,
    report: { disposition: SpawnedReportDisposition; parentId: string },
  ) => {
    actions.reportedParent(
      { disposition: report.disposition, parentId: report.parentId },
      userId,
    );
  };
  const toolSettings =
    dependencies.toolSettings ?? createToolSettingsStore(database);
  const store = createSessionStore(
    database,
    dependencies.randomId ?? createUuidV7,
    (userId) => toolSettings.read(userId),
    runtimes,
    reportParent,
  );
  const recoveryNow = now();
  store.repairSpawnedSessionLineage(recoveryNow);
  store.recoverSpawnedSessionReservations(recoveryNow);
  const shutdown = ShutdownInterruptedSessionStore({
    database,
    generateId: dependencies.randomId ?? createUuidV7,
  });
  const fallbacks = createAttachmentFallbackIntegration({
    database,
    discoverModels: models,
    discoverOpenRouterProviders: discoverProviders,
    generateId: dependencies.randomId ?? createUuidV7,
    now: now,
    providers: providers,
    requests: requests,
    restartSignal: () => restartController.signal,
  });
  const cleanup = createSessionExecutionCleanup(broker);
  const removal = createRunnerRemovalCoordinator({
    broker: broker,
    now: now,
    notify: notify,
    runtimes: runtimes,
    store: store,
  });
  const restart = createSessionRestartControl(
    runtimes,
    () => createUuidV7(now()),
    {
      pendingTools: (sessionId) => [
        ...activeTools.progress(sessionId, false),
        ...broker.pendingToolProgress(sessionId),
      ],
      now: now,
      ...dependencies.restartTiming,
    },
  );
  const actions = createConfiguredSessionAgentActions({
    broker: broker,
    cleanup: cleanup,
    database,
    discoverModels: models,
    discoverOpenRouterProviders: discoverProviders,
    launch: (...parameters) => launch(...parameters),
    restartSignal: () => restartController.signal,
    readCredential: readCredential,
    requests: requests,
    runners: runners,
    ...context(),
    ...credentialRuntime(),
  });
  const finisher = createSessionFinisher({
    actions: actions,
    cleanup: (detail) => {
      void cleanup.cleanup(detail);
    },
    launchQueued: launchQueued,
    reconciliationFailed: (failure) => {
      failureReconciler.pending(failure);
    },
    settled: runtimes.cleared.bind(runtimes),
    ...sessionState(),
  });
  const questions: Parameters<typeof recoverAnsweredQuestions>[0] = {
    launchAnswered: (answered) =>
      launchAnsweredQuestionSession(
        {
          launch: launch,
          questions: questions,
          ...credentialRuntime(),
        },
        answered,
      ),
    notify: notify,
    now: now,
    ownsSession: (userId: string, sessionId: string, workspaceId?: string) => {
      const session = store.get(userId, sessionId, workspaceId);
      return session !== undefined;
    },
    questions: store.questions(),
  };
  const launcher = createSessionLauncher({
    actions: actions,
    attachmentFallbacks: (userId) => fallbacks.store.list(userId),
    beforeLaunch: async (detail) => {
      cleanup.clearOffline(detail.id);
      await cleanup.waitFor(detail.id);
    },
    braveSearch: braveSearch,
    broker: broker,
    discoverModels: models,
    finish: finisher.finish.bind(finisher),
    modelFactory: modelFactory,
    activeTools: activeTools,
    readCredential: readCredential,
    realtime: realtime,
    shouldPersistRestartMarker: (request) =>
      request.requestedBy === "server" || !shutdown.recoveryEnabled(),
    shutdownInterrupted: shutdown,
    ...sessionRuntimeState(),
  });
  const launch = launcher.launch.bind(launcher);
  const realtimeCommands = createRealtimeSessionCommands({
    actions: actions,
    database,
    discoverModels: models,
    discoverOpenRouterProviders: discoverProviders,
    modelCredentialPool: credentialPool,
    providerUpdates: sessionMutationControl(),
    providers: providers,
    questions: questions,
    runnerIsAvailable: runnerAvailable,
    restartSignal: () => restartController.signal,
    toolUpdates: sessionMutationControl(),
    ...launchBoundary(),
  });
  const recover = (runnerId?: string): void => {
    recoverInterruptedSessions(
      { actions: actions, ...sessionRuntimeState() },
      runnerId,
    );
  };
  const restartGate = createSessionRestartCoordinator({
    launch: launch,
    providers: providers,
    recoverInterrupted: recover,
    restart: restart,
    runnerIsAvailable: runnerAvailable,
    ...sessionState(),
  });
  runners.onParentReport((userId, report) => {
    actions.reportedParent(report, userId);
  });
  runners.onRemoving((userId, runnerId) => {
    removal.removing(userId, runnerId);
  });
  runners.onRemoved((userId, runnerId) => removal.removed(userId, runnerId));
  shutdown.recover(now);
  recover();
  restartGate.restoreDurableRunnerGates();
  restartGate.recover();
  reportPendingSpawns({
    actions: actions,
    draining: restart.draining,
    store: store,
  });
  void recoverAnsweredQuestions(questions);
  const queuedOwnerIds = store.queuedSessionOwnerIds();
  // Last so a throw cannot orphan the interval.
  const liveness = createSessionLivenessWatchdog({
    actions: actions,
    afterScan: () => {
      void compactIdleSessions({
        compact: (userId, sessionId) =>
          startManualSessionCompactionForUserId(
            authorizedLaunchBoundary("compact"),
            userId,
            sessionId,
          ),
        database,
        now: now,
      });
    },
    broker: broker,
    cleanup: cleanup.cleanup.bind(cleanup),
    database,
    dependencies,
    runtimes: runtimes,
    shutdownInterrupted: shutdown,
    ...sessionState(),
  });
  queuedOwnerIds.forEach(launchQueued);

  function notify(userId: string, sessionId: string): void {
    for (const listener of onChange) listener(userId, sessionId);
  }

  async function modelsResponse(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    return modelsForUser({
      discoverModels: models,
      request,
      signal: restartController.signal,
      user,
      withCredential,
      workspaces,
    });
  }

  function userActions() {
    return {
      compactionBoundary: (
        operation: Extract<
          RestartHandoffOperation,
          "compact" | "compact_and_continue"
        >,
      ) => authorizedLaunchBoundary(operation),
      discoverModels: models,
      discoverOpenRouterProviders: discoverProviders,
      launchBoundary: () => launchBoundary(),
      restartSignal: () => restartController.signal,
      runnerIsAvailable: runnerAvailable,
      withCredential,
    };
  }

  function context() {
    return {
      modelCredentialPool: credentialPool,
      notify: notify,
      now: now,
    };
  }

  function resources(): SessionIntegrationApiResources {
    return {
      auth: auth,
      broker: broker,
      compactForUser: (user, sessionId, workspaceId) =>
        compactSessionForUser(userActions(), user, sessionId, workspaceId),
      createForUser: (request, user, workspaceId) =>
        createSessionForUser(userActions(), request, user, workspaceId),
      discoverOpenRouterProviders: discoverProviders,
      executionCleanup: cleanup,
      launchQueuedSessions: launchQueued,
      liveness: liveness.watchdog,
      modelsForUser: modelsResponse,
      ...context(),
      questionActions: questions,
      queueForUser: (user, sessionId, workspaceId, prompt) =>
        queueSessionPromptForUser(
          userActions(),
          user,
          sessionId,
          workspaceId,
          prompt,
        ),
      requests: requests,
      restart: restart,
      restartController: restartController,
      restartCoordinator: restartGate,
      runnerRemoval: removal,
      runtimes: runtimes,
      stopChildren: actions.stopChildren.bind(actions),
      stopLivenessScans: liveness.stop,
      shutdownInterrupted: shutdown,
      store: store,
      withCredentialAccess: withCredential,
      workspaces: workspaces,
    };
  }

  function launchQueued(userId: string): void {
    void launchQueuedSessions(
      {
        draining: () => runtimes.draining,
        launch: (detail, credential, ownerId) =>
          launch(detail, credential, ownerId),
        notify: notify,
        readCredential: (ownerId, detail, action) =>
          readCredential(ownerId, detail).then((credential) => {
            if (credential !== undefined) {
              action(credential);
            }
          }),
        runnerIsAvailable: runnerAvailable,
        runtimes: runtimes,
        store: store,
      },
      userId,
    );
  }

  function runnerAvailable(
    userId: string,
    runnerId: string,
    workspaceId?: string,
  ): boolean {
    return (
      restart.accepts(runnerId) &&
      runners.runnerIsAvailable(userId, runnerId, workspaceId)
    );
  }

  function credentialRuntime() {
    return {
      runnerIsAvailable: runnerAvailable,
      runtimes: runtimes,
      store: store,
      withCredential: withCredential,
    };
  }

  function sessionMutationControl() {
    return {
      broker: broker,
      now: now,
      restartSignal: () => restartController.signal,
      runtimes: runtimes,
    };
  }

  function sessionState() {
    return { notify: notify, now: now, store: store };
  }

  function sessionRuntimeState(): Omit<SessionLaunchBoundary, "launch"> {
    return { runtimes: runtimes, ...sessionState() };
  }

  function launchBoundary(): SessionLaunchBoundary {
    return { launch: launch, ...sessionRuntimeState() };
  }

  function authorizedLaunchBoundary(
    operation: Extract<
      RestartHandoffOperation,
      "compact" | "compact_and_continue"
    >,
  ): ManualCompactionDependencies {
    return {
      ...launchBoundary(),
      credential: withCredential,
      operation,
    };
  }

  class ClosureSessionIntegrationApi extends SessionIntegrationApi {
    protected get resources(): SessionIntegrationApiResources {
      return resources();
    }
  }
  const api = new ClosureSessionIntegrationApi();
  return Object.assign(api, {
    abortAgentActionsForRestart: () => {
      restartController.abort("integration test restart");
    },
    agentActionsDraining: () => actions.isDraining(),
    attachmentFallbacks: (request: Request) =>
      fallbacks.api.collection(request),
    hasPendingDatabaseWrites: () => failureReconciler.hasPending(),
    onChange: (listener: (userId: string, sessionId: string) => void) => {
      onChange.add(listener);
    },
    realtimeCommands,
    reconcileDatabaseWrites: () => failureReconciler.reconcile(finisher),
  });
}

export const createSessionIntegration: SessionIntegrationFactory = (
  auth,
  runners,
  providers,
  dependencies,
) => createDrizzleSessionIntegration(auth, runners, providers, dependencies);
