import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
import { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  RestartHandoffOperation,
} from "../shared/session-model.ts";
import {
  discoverAgentModels,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { ChatCompletionsAgentModel } from "./agent-model.ts";
import { createAttachmentFallbackIntegration } from "./attachment-fallback-integration.ts";
import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import { createApiError, parseJsonRequest } from "./http.ts";
import { ModelCredentialPool } from "./model-credential-pool.ts";
import {
  discoverOpenRouterProviders,
  type OpenRouterProviderDiscoverer,
} from "./openrouter-provider-discovery.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import type { SpawnSessionToolInput } from "./session-agent-tools.ts";
import { startManualSessionCompaction } from "./session-compaction-actions.ts";
import {
  createValidatedSession,
  type SessionLaunchBoundary,
} from "./session-creation.ts";
import {
  readSessionCredential,
  withSessionCredential,
  type SessionCredentialAction,
  type SessionCredentialReaders,
  type SessionCredentialSelection,
  type SessionRuntimeSelection,
} from "./session-credential-access.ts";
import {
  permissiveWorkspaceReader,
  type SessionDependencies,
} from "./session-dependencies.ts";
import { SessionExecutionCleanup } from "./session-execution-cleanup.ts";
import { SessionFinisher } from "./session-finisher.ts";
import {
  readCreateSession,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
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
import { modelsForUser } from "./session-model-discovery.ts";
import { sessionMetadata } from "./session-provider-selection.ts";
import {
  recoverAnsweredQuestions,
  type SessionQuestionActionDependencies,
} from "./session-question-actions.ts";
import { launchAnsweredQuestionSession } from "./session-question-launcher.ts";
import { queueSessionForUser } from "./session-queue.ts";
import { launchQueuedSessions } from "./session-queued-launcher.ts";
import { createRealtimeSessionCommands } from "./session-realtime-factory.ts";
import type { RealtimeSessionCommands } from "./session-realtime-integration.ts";
import { SessionRequestHelpers } from "./session-request-helpers.ts";
import { createSessionRestartControl } from "./session-restart-control.ts";
import { SessionRestartCoordinator } from "./session-restart-coordinator.ts";
import { RunnerRemovalCoordinator } from "./session-runner-removal.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import { ShutdownInterruptedSessionStore } from "./session-shutdown-interrupted-store.ts";
import { SessionStore } from "./session-store.ts";
import type { SessionWorkspaceReader } from "./session-workspace.ts";

export type { SessionIntegration } from "./session-integration.ts";

class DrizzleSessionIntegration
  extends SessionIntegrationApi
  implements SessionIntegration
{
  readonly #broker: RunnerCommandBroker;
  readonly #auth: GoogleAuth;
  readonly #braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly #discoverModels: AgentModelDiscoverer;
  readonly #discoverOpenRouterProviders: OpenRouterProviderDiscoverer;
  readonly #modelCredentialPool: ModelCredentialPool;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #onChange = new Set<(userId: string, sessionId: string) => void>();
  readonly #providers: SessionCredentialReaders;
  readonly #realtime: RealtimeHub | undefined;
  readonly #realtimeCommands: RealtimeSessionCommands;
  readonly #questionActions: SessionQuestionActionDependencies;
  readonly #requests: SessionRequestHelpers;
  readonly #launch: SessionLaunchBoundary["launch"];
  readonly #executionCleanup: SessionExecutionCleanup;
  readonly #finisher: SessionFinisher;
  readonly #runners: RunnerIntegration;
  readonly #runtimes = new SessionRuntimes();
  readonly #restart;
  readonly #restartCoordinator: SessionRestartCoordinator;
  readonly #runnerRemoval: RunnerRemovalCoordinator;
  readonly #shutdownInterrupted: ShutdownInterruptedSessionStore;
  readonly #store: SessionStore;
  readonly #workspaces: SessionWorkspaceReader;
  readonly #actions: SessionAgentActions;
  readonly #attachmentFallbacks: ReturnType<
    typeof createAttachmentFallbackIntegration
  >;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
    super();
    this.#auth = auth;
    this.#realtime = dependencies.realtime;
    this.#broker =
      dependencies.broker ??
      new RunnerCommandBroker({
        cancel: (runnerId, commandId) =>
          this.#realtime?.publishRunnerCancellation(runnerId, commandId),
        deliver: (runnerId, command) =>
          this.#realtime?.publishRunnerCommand(runnerId, command) === true,
      });
    this.#braveSearch = dependencies.braveSearch;
    const database = dependencies.database ?? createDatabase(":memory:");
    this.#discoverModels = dependencies.discoverModels ?? discoverAgentModels;
    this.#discoverOpenRouterProviders =
      dependencies.discoverOpenRouterProviders ?? discoverOpenRouterProviders;
    this.#modelFactory =
      dependencies.modelFactory ??
      ((options) => new ChatCompletionsAgentModel(options));
    this.#now = dependencies.now ?? Date.now;
    this.#providers = providers;
    this.#modelCredentialPool = new ModelCredentialPool({
      database,
      readCredential: this.#readCredential,
    });
    this.#workspaces = dependencies.workspaces ?? permissiveWorkspaceReader;
    this.#requests = new SessionRequestHelpers(auth, this.#broker, runners);
    this.#runners = runners;
    this.#store = new SessionStore(
      database,
      dependencies.randomId ?? createUuidV7,
    );
    this.#shutdownInterrupted = new ShutdownInterruptedSessionStore({
      database,
      generateId: dependencies.randomId ?? createUuidV7,
    });
    this.#attachmentFallbacks = createAttachmentFallbackIntegration({
      database,
      discoverModels: this.#discoverModels,
      discoverOpenRouterProviders: this.#discoverOpenRouterProviders,
      generateId: dependencies.randomId ?? createUuidV7,
      now: this.#now,
      providers: this.#providers,
      requests: this.#requests,
    });
    this.#executionCleanup = new SessionExecutionCleanup(this.#broker);
    this.#runnerRemoval = new RunnerRemovalCoordinator({
      broker: this.#broker,
      now: this.#now,
      notify: this.#notify,
      runtimes: this.#runtimes,
      store: this.#store,
    });
    this.#restart = createSessionRestartControl(this.#runtimes, () =>
      createUuidV7(this.#now()),
    );
    this.#actions = this.#createActions(database);
    this.#finisher = new SessionFinisher({
      actions: this.#actions,
      cleanup: (detail) => {
        void this.#executionCleanup.cleanup(detail);
      },
      launchQueued: this.#launchQueuedSessions,
      settled: (sessionId) => this.#runtimes.cleared(sessionId),
      ...this.#sessionState(),
    });
    this.#questionActions = {
      launchAnswered: (answered) =>
        launchAnsweredQuestionSession(
          {
            launch: this.#launch,
            questions: this.#questionActions,
            runnerIsAvailable: this.#runnerIsAvailable,
            runtimes: this.#runtimes,
            store: this.#store,
            withCredential: this.#withCredentialAccess,
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
      attachmentFallbacks: (userId) =>
        this.#attachmentFallbacks.store.list(userId),
      beforeLaunch: async (detail) => {
        this.#executionCleanup.clearOffline(detail.id);
        await this.#executionCleanup.waitFor(detail.id);
      },
      braveSearch: this.#braveSearch,
      broker: this.#broker,
      discoverModels: this.#discoverModels,
      finish: (detail, userId, error, recovered) => {
        this.#finisher.finish(detail, userId, error, recovered);
      },
      modelFactory: this.#modelFactory,
      readCredential: this.#readCredential,
      realtime: this.#realtime,
      shutdownInterrupted: this.#shutdownInterrupted,
      ...this.#sessionRuntimeState(),
    });
    this.#launch = launcher.launch.bind(launcher);
    this.#realtimeCommands = createRealtimeSessionCommands({
      actions: this.#actions,
      database,
      discoverModels: this.#discoverModels,
      discoverOpenRouterProviders: this.#discoverOpenRouterProviders,
      modelCredentialPool: this.#modelCredentialPool,
      providerUpdates: this.#sessionMutationControl(),
      providers: this.#providers,
      questions: this.#questionActions,
      runnerIsAvailable: this.#runnerIsAvailable,
      toolUpdates: this.#sessionMutationControl(),
      ...this.#launchBoundary(),
    });
    const recover = (runnerId?: string): void => {
      recoverInterruptedSessions(
        { actions: this.#actions, now: this.#now, store: this.#store },
        runnerId,
      );
    };
    this.#restartCoordinator = new SessionRestartCoordinator({
      launch: this.#launch,
      providers: this.#providers,
      recoverInterrupted: recover,
      restart: this.#restart,
      runnerIsAvailable: this.#runnerIsAvailable,
      ...this.#sessionState(),
    });
    this.#runners.onRemoving((userId, runnerId) => {
      this.#runnerRemoval.removing(userId, runnerId);
    });
    this.#runners.onRemoved((userId, runnerId) =>
      this.#runnerRemoval.removed(userId, runnerId),
    );
    this.#shutdownInterrupted.recover(this.#now);
    recover();
    this.#restartCoordinator.restoreDurableRunnerGates();
    this.#restartCoordinator.recover();
    reportPendingSpawns({
      actions: this.#actions,
      draining: this.#restart.draining,
      store: this.#store,
    });
    void recoverAnsweredQuestions(this.#questionActions);
    this.#store.queuedSessionOwnerIds().forEach(this.#launchQueuedSessions);
  }

  protected get resources(): SessionIntegrationApiResources {
    return {
      auth: this.#auth,
      broker: this.#broker,
      compactForUser: (user, sessionId, workspaceId) =>
        this.#compactForUser(user, sessionId, workspaceId),
      createForUser: (request, user, workspaceId) =>
        this.#createForUser(request, user, workspaceId),
      discoverOpenRouterProviders: this.#discoverOpenRouterProviders,
      executionCleanup: this.#executionCleanup,
      launchQueuedSessions: this.#launchQueuedSessions,
      modelsForUser: (request, user) => this.#modelsForUser(request, user),
      modelCredentialPool: this.#modelCredentialPool,
      notify: this.#notify,
      now: this.#now,
      questionActions: this.#questionActions,
      queueForUser: (user, sessionId, workspaceId, prompt) =>
        this.#queueForUser(user, sessionId, workspaceId, prompt),
      requests: this.#requests,
      restart: this.#restart,
      restartCoordinator: this.#restartCoordinator,
      runnerRemoval: this.#runnerRemoval,
      runtimes: this.#runtimes,
      stopChildren: this.#actions.stopChildren.bind(this.#actions),
      store: this.#store,
      withCredentialAccess: this.#withCredentialAccess,
      workspaces: this.#workspaces,
    };
  }

  readonly #launchQueuedSessions = (userId: string): void => {
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
        runnerIsAvailable: this.#runnerIsAvailable,
        runtimes: this.#runtimes,
        store: this.#store,
      },
      userId,
    );
  };

  readonly #runnerIsAvailable = (
    userId: string,
    runnerId: string,
    workspaceId?: string,
  ): boolean =>
    this.#restart.accepts(runnerId) &&
    this.#runners.runnerIsAvailable(userId, runnerId, workspaceId);

  #sessionMutationControl() {
    return {
      broker: this.#broker,
      now: this.#now,
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
  ): Parameters<typeof startManualSessionCompaction>[0] {
    return {
      ...this.#launchBoundary(),
      credential: this.#withCredentialAccess,
      operation,
    };
  }

  async #discoverSessionMetadata(
    input: SpawnSessionToolInput,
    credential: ProviderCredentialAccess,
    ownerId: string,
    rejectCredentialErrors: boolean,
  ): Promise<Pick<AgentSessionDetail, "maxContextTokens" | "providerPricing">> {
    const metadata = await this.#metadata(
      input,
      credential,
      ownerId,
      rejectCredentialErrors,
    );
    if ("error" in metadata) {
      throw new Error(
        metadata.error === "provider_unavailable"
          ? "The OpenRouter serving provider is unavailable"
          : "The OpenRouter serving provider could not be validated",
      );
    }
    return metadata;
  }

  #metadata(
    input: Parameters<typeof sessionMetadata>[0]["input"],
    credential: ProviderCredentialAccess,
    ownerId: string,
    rejectCredentialErrors: boolean,
  ) {
    return sessionMetadata({
      credential,
      discoverModels: this.#discoverModels,
      discoverProviders: this.#discoverOpenRouterProviders,
      input,
      ownerId,
      rejectCredentialErrors,
    });
  }

  #createActions(database: AppDatabase): SessionAgentActions {
    return new SessionAgentActions({
      activeSession: (id) => this.#runtimes.active(id),
      settled: this.#runtimes.cleared.bind(this.#runtimes),
      abortSession: this.#runtimes.abort.bind(this.#runtimes),
      broker: this.#broker,
      browseDirectories: (request, signal) =>
        this.#requests.browseDirectories(request, signal),
      database,
      discoverModels: this.#discoverModels,
      draining: () => this.#runtimes.draining,
      cleanupSession: (detail) => {
        void this.#executionCleanup.cleanupTerminal(detail);
      },
      pendingRestart: (runnerId) => this.#runtimes.pendingRestart(runnerId),
      discoverSessionMetadata: (
        input,
        credential,
        userId,
        rejectCredentialErrors,
      ) =>
        this.#discoverSessionMetadata(
          input,
          credential,
          userId,
          rejectCredentialErrors,
        ),
      launchSession: (credential, detail, userId) =>
        this.#launch(detail, credential, userId),
      listOnlineRunners: (userId, workspaceId) =>
        this.#runners.onlineForUser(userId, workspaceId),
      listRunnerOptions: (userId, request) =>
        this.#runners.listOnlineForUser(
          userId,
          {
            limit: request.limit,
            offset: request.offset,
            ...(request.search === undefined ? {} : { search: request.search }),
          },
          request.workspaceId,
        ),
      modelCredentialPool: this.#modelCredentialPool,
      notify: this.#notify,
      now: this.#now,
      readCredential: this.#readCredential,
      runnerIsAvailable: this.#runnerIsAvailable,
      store: this.#store,
      withCredential: this.#withCredentialAccess,
    });
  }

  attachmentFallbacks(request: Request): Promise<Response> | Response {
    return this.#attachmentFallbacks.api.collection(request);
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

  readonly #readCredential = async (
    userId: string,
    selection: SessionCredentialSelection,
  ): Promise<ProviderCredentialAccess | undefined> =>
    readSessionCredential(this.#providers, userId, selection);

  readonly #withCredentialAccess = (
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ): Promise<Response> =>
    withSessionCredential(this.#providers, userId, selection, action);

  async #withRuntimeAccess(
    userId: string,
    selection: SessionRuntimeSelection,
    action: SessionCredentialAction,
  ): Promise<Response> {
    return this.#runnerIsAvailable(
      userId,
      selection.runnerId,
      selection.workspaceId,
    )
      ? this.#withCredentialAccess(userId, selection, action)
      : createApiError("runner_unavailable", 409);
  }

  async #modelsForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    return modelsForUser({
      discoverModels: this.#discoverModels,
      request,
      user,
      withCredential: this.#withCredentialAccess,
      workspaces: this.#workspaces,
    });
  }

  async #createForUser(
    request: Request,
    user: AuthenticatedUser,
    workspaceId: string,
  ): Promise<Response> {
    const input = await parseJsonRequest(request, readCreateSession);
    return input === undefined
      ? createApiError("invalid_request", 400)
      : this.#createValidatedSession(user, input, workspaceId);
  }

  async #createValidatedSession(
    user: AuthenticatedUser,
    input: CreateSessionInput,
    workspaceId: string,
  ): Promise<Response> {
    const scopedInput = { ...input, workspaceId };
    return this.#withRuntimeAccess(user.id, scopedInput, (credential) =>
      createValidatedSession(
        {
          discoverModels: this.#discoverModels,
          discoverOpenRouterProviders: this.#discoverOpenRouterProviders,
          ...this.#launchBoundary(),
        },
        user,
        scopedInput,
        credential,
      ),
    );
  }

  async #compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
  ): Promise<Response> {
    return startManualSessionCompaction(
      { ...this.#authorizedLaunchBoundary("compact"), workspaceId },
      user,
      sessionId,
    );
  }

  async #queueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
    prompt?: PromptInput,
  ): Promise<Response> {
    return queueSessionForUser(
      {
        ...this.#launchBoundary(),
        credential: this.#withCredentialAccess,
        runnerIsAvailable: this.#runnerIsAvailable,
        workspaceId,
      },
      user.id,
      sessionId,
      prompt,
    );
  }
}

export const createSessionIntegration: SessionIntegrationFactory = (
  auth,
  runners,
  providers,
  dependencies,
) => new DrizzleSessionIntegration(auth, runners, providers, dependencies);
