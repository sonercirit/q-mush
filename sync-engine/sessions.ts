import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import {
  createRunnerCommandBroker,
  type RunnerCommandBroker,
} from "../shared/runner-command-broker.ts";
import type { RestartHandoffOperation } from "../shared/session-model.ts";
import { ActiveSessionTools } from "./active-session-tools.ts";
import {
  discoverAgentModels,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { ChatCompletionsAgentModel } from "./agent-model.ts";
import { createAttachmentFallbackIntegration } from "./attachment-fallback-integration.ts";
import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import { ModelCredentialPool } from "./model-credential-pool.ts";
import {
  discoverOpenRouterProviders,
  type OpenRouterProviderDiscoverer,
} from "./openrouter-provider-discovery.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import { createSessionAgentActions } from "./session-agent-actions-factory.ts";
import type { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import {
  startManualSessionCompactionForUserId,
  type ManualCompactionDependencies,
} from "./session-compaction-actions.ts";
import type { SessionLaunchBoundary } from "./session-creation.ts";
import type { SessionCredentialReaders } from "./session-credential-access.ts";
import { SessionCredentialAccess } from "./session-credential-service.ts";
import {
  permissiveWorkspaceReader,
  type SessionDependencies,
} from "./session-dependencies.ts";
import { SessionExecutionCleanup } from "./session-execution-cleanup.ts";
import { SessionFailureReconciler } from "./session-failure-reconciler.ts";
import { SessionFinisher } from "./session-finisher.ts";
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
import { SessionLauncher } from "./session-launcher.ts";
import { createSessionLivenessWatchdog } from "./session-liveness-scheduler.ts";
import { modelsForUser } from "./session-model-discovery.ts";
import {
  recoverAnsweredQuestions,
  type SessionQuestionActionDependencies,
} from "./session-question-actions.ts";
import { launchAnsweredQuestionSession } from "./session-question-launcher.ts";
import { launchQueuedSessions } from "./session-queued-launcher.ts";
import { createRealtimeSessionCommands } from "./session-realtime-factory.ts";
import type { RealtimeSessionCommands } from "./session-realtime-integration.ts";
import { SessionRequestHelpers } from "./session-request-helpers.ts";
import { SessionRestartAbort } from "./session-restart-abort.ts";
import { createSessionRestartControl } from "./session-restart-control.ts";
import { SessionRestartCoordinator } from "./session-restart-coordinator.ts";
import { RunnerRemovalCoordinator } from "./session-runner-removal.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import type { SpawnedReportDisposition } from "./session-store-spawns.ts";
import { SessionStore } from "./session-store.ts";
import {
  compactSessionForUser,
  createSessionForUser,
  queueSessionPromptForUser,
  type SessionUserActionDependencies,
} from "./session-user-actions.ts";
import type { SessionWorkspaceReader } from "./session-workspace.ts";
import { ToolSettingsStore } from "./tool-settings-store.ts";

export type { SessionIntegration } from "./session-integration.ts";

class DrizzleSessionIntegration
  extends SessionIntegrationApi
  implements SessionIntegration
{
  readonly #activeTools: ActiveSessionTools;
  readonly #broker: RunnerCommandBroker;
  readonly #auth: GoogleAuth;
  readonly #braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly #models: AgentModelDiscoverer;
  readonly #discoverProviders: OpenRouterProviderDiscoverer;
  readonly #credentialPool: ModelCredentialPool;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #onChange = new Set<(userId: string, sessionId: string) => void>();
  readonly #providers: SessionCredentialReaders;
  readonly #realtime: RealtimeHub | undefined;
  readonly #realtimeCommands: RealtimeSessionCommands;
  readonly #questions: SessionQuestionActionDependencies;
  readonly #requests: SessionRequestHelpers;
  readonly #launch: SessionLaunchBoundary["launch"];
  readonly #liveness;
  readonly #cleanup: SessionExecutionCleanup;
  readonly #finisher: SessionFinisher;
  readonly #failureReconciler = new SessionFailureReconciler();
  readonly #runners: RunnerIntegration;
  readonly #runtimes: SessionRuntimes;
  readonly #restartController = new SessionRestartAbort();
  readonly #restart;
  readonly #restartGate: SessionRestartCoordinator;
  readonly #removal: RunnerRemovalCoordinator;
  readonly #shutdown: ShutdownInterruptedSessionStore;
  readonly #store: SessionStore;
  readonly #toolSettings: Pick<ToolSettingsStore, "read">;
  readonly #workspaces: SessionWorkspaceReader;
  readonly #actions: SessionAgentActions;

  /** @internal Exposes the configured restart gate to integration tests. */
  agentActionsDraining(): boolean {
    return this.#actions.isDraining();
  }

  /** @internal Simulates a restart boundary in integration tests. */
  abortAgentActionsForRestart(): void {
    this.#restartController.abort("integration test restart");
  }
  readonly #fallbacks: ReturnType<typeof createAttachmentFallbackIntegration>;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
    super();
    this.#auth = auth;
    this.#activeTools = dependencies.activeTools ?? new ActiveSessionTools();
    this.#realtime = dependencies.realtime;
    this.#broker =
      dependencies.broker ??
      createRunnerCommandBroker({
        cancel: (runnerId, commandId) =>
          this.#realtime?.publishRunnerCancellation(runnerId, commandId),
        deliver: (runnerId, command) =>
          this.#realtime?.publishRunnerCommand(runnerId, command) === true,
      });
    this.#braveSearch = dependencies.braveSearch;
    const database = dependencies.database ?? createDatabase(":memory:");
    this.#models = dependencies.discoverModels ?? discoverAgentModels;
    this.#discoverProviders =
      dependencies.discoverOpenRouterProviders ?? discoverOpenRouterProviders;
    this.#modelFactory =
      dependencies.modelFactory ??
      ((options) => new ChatCompletionsAgentModel(options));
    this.#now = dependencies.now ?? Date.now;
    this.#runtimes = new SessionRuntimes(this.#now);
    this.#providers = providers;
    const credentials = new SessionCredentialAccess(providers);
    this.#readCredential = credentials.read;
    this.#withCredential = credentials.with;
    this.#credentialPool = new ModelCredentialPool({
      database,
      readCredential: this.#readCredential,
    });
    this.#workspaces = dependencies.workspaces ?? permissiveWorkspaceReader;
    this.#requests = new SessionRequestHelpers(auth, this.#broker, runners);
    this.#runners = runners;
    const reportParent = (
      userId: string,
      report: { disposition: SpawnedReportDisposition; parentId: string },
    ) => {
      this.#actions.reportedParent(
        { disposition: report.disposition, parentId: report.parentId },
        userId,
      );
    };
    this.#toolSettings =
      dependencies.toolSettings ?? new ToolSettingsStore(database);
    this.#store = new SessionStore(
      database,
      dependencies.randomId ?? createUuidV7,
      (userId) => this.#toolSettings.read(userId),
      this.#runtimes,
      reportParent,
    );
    const recoveryNow = this.#now();
    this.#store.repairSpawnedSessionLineage(recoveryNow);
    this.#store.recoverSpawnedSessionReservations(recoveryNow);
    this.#shutdown = new ShutdownInterruptedSessionStore({
      database,
      generateId: dependencies.randomId ?? createUuidV7,
    });
    this.#fallbacks = createAttachmentFallbackIntegration({
      database,
      discoverModels: this.#models,
      discoverOpenRouterProviders: this.#discoverProviders,
      generateId: dependencies.randomId ?? createUuidV7,
      now: this.#now,
      providers: this.#providers,
      requests: this.#requests,
      restartSignal: () => this.#restartController.signal,
    });
    this.#cleanup = new SessionExecutionCleanup(this.#broker);
    this.#removal = new RunnerRemovalCoordinator({
      broker: this.#broker,
      now: this.#now,
      notify: this.#notify,
      runtimes: this.#runtimes,
      store: this.#store,
    });
    this.#restart = createSessionRestartControl(
      this.#runtimes,
      () => createUuidV7(this.#now()),
      {
        pendingTools: (sessionId) => [
          ...this.#activeTools.progress(sessionId, false),
          ...this.#broker.pendingToolProgress(sessionId),
        ],
        now: this.#now,
        ...dependencies.restartTiming,
      },
    );
    this.#actions = createSessionAgentActions({
      broker: this.#broker,
      cleanup: this.#cleanup,
      database,
      discoverModels: this.#models,
      discoverOpenRouterProviders: this.#discoverProviders,
      launch: (...parameters) => this.#launch(...parameters),
      restartSignal: () => this.#restartController.signal,
      readCredential: this.#readCredential,
      requests: this.#requests,
      runners: this.#runners,
      ...this.#context(),
      ...this.#credentialRuntime(),
    });
    this.#finisher = new SessionFinisher({
      actions: this.#actions,
      cleanup: (detail) => {
        void this.#cleanup.cleanup(detail);
      },
      launchQueued: this.#launchQueued,
      reconciliationFailed: (failure) => {
        this.#failureReconciler.pending(failure);
      },
      settled: this.#runtimes.cleared.bind(this.#runtimes),
      ...this.#sessionState(),
    });
    this.#questions = {
      launchAnswered: (answered) =>
        launchAnsweredQuestionSession(
          {
            launch: this.#launch,
            questions: this.#questions,
            ...this.#credentialRuntime(),
          },
          answered,
        ),
      notify: this.#notify,
      now: this.#now,
      ownsSession: (userId: string, sessionId: string, workspaceId?: string) =>
        this.#store.get(userId, sessionId, workspaceId) !== undefined,
      questions: this.#store.questions(),
    };
    const launcher = new SessionLauncher({
      actions: this.#actions,
      attachmentFallbacks: (userId) => this.#fallbacks.store.list(userId),
      beforeLaunch: async (detail) => {
        this.#cleanup.clearOffline(detail.id);
        await this.#cleanup.waitFor(detail.id);
      },
      braveSearch: this.#braveSearch,
      broker: this.#broker,
      discoverModels: this.#models,
      finish: (detail, userId, error, recovered) => {
        this.#finisher.finish(detail, userId, error, recovered);
      },
      modelFactory: this.#modelFactory,
      activeTools: this.#activeTools,
      readCredential: this.#readCredential,
      realtime: this.#realtime,
      shouldPersistRestartMarker: (request) =>
        request.requestedBy === "server" || !this.#shutdown.recoveryEnabled(),
      shutdownInterrupted: this.#shutdown,
      ...this.#sessionRuntimeState(),
    });
    this.#launch = launcher.launch.bind(launcher);
    this.#realtimeCommands = createRealtimeSessionCommands({
      actions: this.#actions,
      database,
      discoverModels: this.#models,
      discoverOpenRouterProviders: this.#discoverProviders,
      modelCredentialPool: this.#credentialPool,
      providerUpdates: this.#sessionMutationControl(),
      providers: this.#providers,
      questions: this.#questions,
      runnerIsAvailable: this.#runnerAvailable,
      restartSignal: () => this.#restartController.signal,
      toolUpdates: this.#sessionMutationControl(),
      ...this.#launchBoundary(),
    });
    const recover = (runnerId?: string): void => {
      recoverInterruptedSessions(
        { actions: this.#actions, ...this.#sessionRuntimeState() },
        runnerId,
      );
    };
    this.#restartGate = new SessionRestartCoordinator({
      launch: this.#launch,
      providers: this.#providers,
      recoverInterrupted: recover,
      restart: this.#restart,
      runnerIsAvailable: this.#runnerAvailable,
      ...this.#sessionState(),
    });
    this.#runners.onParentReport((userId, report) => {
      this.#actions.reportedParent(report, userId);
    });
    this.#runners.onRemoving((userId, runnerId) => {
      this.#removal.removing(userId, runnerId);
    });
    this.#runners.onRemoved((userId, runnerId) =>
      this.#removal.removed(userId, runnerId),
    );
    this.#shutdown.recover(this.#now);
    recover();
    this.#restartGate.restoreDurableRunnerGates();
    this.#restartGate.recover();
    reportPendingSpawns({
      actions: this.#actions,
      draining: this.#restart.draining,
      store: this.#store,
    });
    void recoverAnsweredQuestions(this.#questions);
    const queuedOwnerIds = this.#store.queuedSessionOwnerIds();
    // Last so a throw cannot orphan the interval.
    this.#liveness = createSessionLivenessWatchdog({
      actions: this.#actions,
      afterScan: () => {
        void compactIdleSessions({
          compact: (userId, sessionId) =>
            startManualSessionCompactionForUserId(
              this.#authorizedLaunchBoundary("compact"),
              userId,
              sessionId,
            ),
          database,
          now: this.#now,
        });
      },
      broker: this.#broker,
      cleanup: this.#cleanup.cleanup.bind(this.#cleanup),
      database,
      dependencies,
      runtimes: this.#runtimes,
      shutdownInterrupted: this.#shutdown,
      ...this.#sessionState(),
    });
    queuedOwnerIds.forEach(this.#launchQueued);
  }

  #context() {
    return {
      modelCredentialPool: this.#credentialPool,
      notify: this.#notify,
      now: this.#now,
    };
  }

  protected get resources(): SessionIntegrationApiResources {
    return {
      auth: this.#auth,
      broker: this.#broker,
      compactForUser: (user, sessionId, workspaceId) =>
        compactSessionForUser(
          this.#userActions(),
          user,
          sessionId,
          workspaceId,
        ),
      createForUser: (request, user, workspaceId) =>
        createSessionForUser(this.#userActions(), request, user, workspaceId),
      discoverOpenRouterProviders: this.#discoverProviders,
      executionCleanup: this.#cleanup,
      launchQueuedSessions: this.#launchQueued,
      liveness: this.#liveness.watchdog,
      modelsForUser: (request, user) => this.#modelsForUser(request, user),
      ...this.#context(),
      questionActions: this.#questions,
      queueForUser: (user, sessionId, workspaceId, prompt) =>
        queueSessionPromptForUser(
          this.#userActions(),
          user,
          sessionId,
          workspaceId,
          prompt,
        ),
      requests: this.#requests,
      restart: this.#restart,
      restartController: this.#restartController,
      restartCoordinator: this.#restartGate,
      runnerRemoval: this.#removal,
      runtimes: this.#runtimes,
      stopChildren: this.#actions.stopChildren.bind(this.#actions),
      stopLivenessScans: this.#liveness.stop,
      shutdownInterrupted: this.#shutdown,
      store: this.#store,
      withCredentialAccess: this.#withCredential,
      workspaces: this.#workspaces,
    };
  }

  readonly #launchQueued = (userId: string): void => {
    void launchQueuedSessions(
      {
        draining: () => this.#runtimes.draining,
        launch: (detail, credential, ownerId) =>
          this.#launch(detail, credential, ownerId),
        notify: this.#notify,
        readCredential: (ownerId, detail, action) =>
          this.#readCredential(ownerId, detail).then((credential) => {
            if (credential !== undefined) {
              action(credential);
            }
          }),
        runnerIsAvailable: this.#runnerAvailable,
        runtimes: this.#runtimes,
        store: this.#store,
      },
      userId,
    );
  };

  readonly #runnerAvailable = (
    userId: string,
    runnerId: string,
    workspaceId?: string,
  ): boolean =>
    this.#restart.accepts(runnerId) &&
    this.#runners.runnerIsAvailable(userId, runnerId, workspaceId);

  #credentialRuntime() {
    return {
      runnerIsAvailable: this.#runnerAvailable,
      runtimes: this.#runtimes,
      store: this.#store,
      withCredential: this.#withCredential,
    };
  }

  #sessionMutationControl() {
    return {
      broker: this.#broker,
      now: this.#now,
      restartSignal: () => this.#restartController.signal,
      runtimes: this.#runtimes,
    };
  }

  #sessionState() {
    return { notify: this.#notify, now: this.#now, store: this.#store };
  }

  #sessionRuntimeState(): Omit<SessionLaunchBoundary, "launch"> {
    return { runtimes: this.#runtimes, ...this.#sessionState() };
  }

  #launchBoundary(): SessionLaunchBoundary {
    return { launch: this.#launch, ...this.#sessionRuntimeState() };
  }

  #authorizedLaunchBoundary(
    operation: Extract<
      RestartHandoffOperation,
      "compact" | "compact_and_continue"
    >,
  ): ManualCompactionDependencies {
    return {
      ...this.#launchBoundary(),
      credential: this.#withCredential,
      operation,
    };
  }

  attachmentFallbacks(request: Request): Promise<Response> | Response {
    return this.#fallbacks.api.collection(request);
  }

  hasPendingDatabaseWrites(): boolean {
    return this.#failureReconciler.hasPending();
  }

  reconcileDatabaseWrites(): boolean {
    return this.#failureReconciler.reconcile(this.#finisher);
  }

  onChange(listener: (userId: string, sessionId: string) => void): void {
    this.#onChange.add(listener);
  }

  get realtimeCommands() {
    return this.#realtimeCommands;
  }

  readonly #notify = (userId: string, sessionId: string): void => {
    for (const listener of this.#onChange) {
      listener(userId, sessionId);
    }
  };

  readonly #readCredential: SessionCredentialAccess["read"];

  readonly #withCredential: SessionCredentialAccess["with"];

  async #modelsForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    return modelsForUser({
      discoverModels: this.#models,
      request,
      signal: this.#restartController.signal,
      user,
      withCredential: this.#withCredential,
      workspaces: this.#workspaces,
    });
  }

  #userActions(): SessionUserActionDependencies {
    return {
      compactionBoundary: (operation) =>
        this.#authorizedLaunchBoundary(operation),
      discoverModels: this.#models,
      discoverOpenRouterProviders: this.#discoverProviders,
      launchBoundary: () => this.#launchBoundary(),
      restartSignal: () => this.#restartController.signal,
      runnerIsAvailable: this.#runnerAvailable,
      withCredential: this.#withCredential,
    };
  }
}

export const createSessionIntegration: SessionIntegrationFactory = (
  auth,
  runners,
  providers,
  dependencies,
) => new DrizzleSessionIntegration(auth, runners, providers, dependencies);
