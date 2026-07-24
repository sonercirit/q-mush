import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "../shared/provider-credential-store.ts";
import {
  RunnerCommandBroker,
  type RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import {
  discoverAgentModels,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import { ChatCompletionsAgentModel } from "./agent-model.ts";
import type { GoogleAuth } from "./auth.ts";
import type { BraveSearchSkill } from "./brave-search.ts";
import { RealtimeCommandFailure } from "./realtime-command-ledger.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import { unavailableSessionError } from "./session-availability.ts";
import { startManualSessionCompaction } from "./session-compaction-actions.ts";
import {
  selectedSessionModel,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import { sessionModelRuntime } from "./session-model-runtime.ts";
import type { SessionRealtimeCommands } from "./session-realtime-commands.ts";
import { SessionRequestHelpers } from "./session-request-helpers.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import { SessionStore } from "./session-store.ts";

interface SessionCredentialReader {
  readCredential(
    userId: string,
    credentialId: string,
  ):
    | Promise<ProviderCredentialAccess | undefined>
    | ProviderCredentialAccess
    | undefined;
}

export type SessionCredentialReaders = Readonly<
  Record<ProviderId, SessionCredentialReader>
>;

type SessionAction<Result> = (
  credential: ProviderCredentialAccess,
) => Promise<Result> | Result;

interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly database?: AppDatabase;
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
  readonly realtime?: RealtimeHub;
}

interface CredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

interface RuntimeSelection extends CredentialSelection {
  readonly runnerId: string;
}

export interface SessionIntegration extends SessionRealtimeCommands {
  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    output: string,
  ): boolean;
  deliverRunnerCommands(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void;
  directories(request: Request, runnerId: string): Promise<Response>;
  drain(): Promise<void>;
  onChange(listener: (userId: string, sessionId: string) => void): void;
  runnerConnected(): void;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class DrizzleSessionIntegration implements SessionIntegration {
  readonly #broker: RunnerCommandBroker;
  readonly #braveSearch: Pick<BraveSearchSkill, "execute">;
  readonly #discoverModels: AgentModelDiscoverer;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #onChange = new Set<(userId: string, sessionId: string) => void>();
  readonly #providers: SessionCredentialReaders;
  readonly #realtime: RealtimeHub | undefined;
  readonly #requests: SessionRequestHelpers;
  readonly #runners: RunnerIntegration;
  readonly #runtimes = new SessionRuntimes();
  readonly #store: SessionStore;
  readonly #actions: SessionAgentActions;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
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
    this.#discoverModels = dependencies.discoverModels ?? discoverAgentModels;
    this.#modelFactory =
      dependencies.modelFactory ??
      ((options) => new ChatCompletionsAgentModel(options));
    this.#now = dependencies.now ?? Date.now;
    this.#providers = providers;
    this.#requests = new SessionRequestHelpers(auth, this.#broker, runners);
    this.#runners = runners;
    this.#store = new SessionStore(
      dependencies.database ?? createDatabase(":memory:"),
      dependencies.randomId ?? createUuidV7,
    );
    this.#actions = this.#createActions();
    this.#actions.reportAll(this.#store.failInterrupted(this.#now()));
  }

  #createActions(): SessionAgentActions {
    return new SessionAgentActions({
      activeSession: (sessionId) => this.#runtimes.active(sessionId),
      abortSession: (sessionId) => {
        this.#runtimes.abort(sessionId);
      },
      broker: this.#broker,
      draining: () => this.#runtimes.draining,
      discoverSessionMetadata: async (input, credential) => {
        try {
          const catalog = await this.#discoverModels(
            input.provider,
            credential,
          );
          const model = catalog.models.find(({ id }) => id === input.model);
          return {
            maxContextTokens: model?.contextWindow ?? null,
            providerPricing: model?.pricing ?? null,
          };
        } catch {
          return { maxContextTokens: null, providerPricing: null };
        }
      },
      launchSession: (credential, detail, userId) =>
        this.#launch(detail, credential, userId),
      notify: this.#notify,
      now: this.#now,
      runnerIsAvailable: (userId, runnerId) =>
        this.#runners.runnerIsAvailable(userId, runnerId),
      store: this.#store,
      withCredential: (userId, selection, action) =>
        this.#withCredentialAccess(userId, selection, action),
    });
  }

  compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<AgentSessionDetail> {
    return startManualSessionCompaction(
      {
        credential: async (userId, detail, action) => {
          await this.#withCredentialAccess(userId, detail, action);
        },
        launch: (detail, credential, userId) => {
          this.#launch(detail, credential, userId, true);
        },
        notify: this.#notify,
        now: this.#now,
        runtimes: this.#runtimes,
        store: this.#store,
      },
      user,
      sessionId,
    );
  }

  completeRunnerCommand(
    runnerId: string,
    commandId: string,
    output: string,
  ): boolean {
    return this.#broker.complete(runnerId, commandId, output);
  }

  #ensureAcceptingCommands(): void {
    if (this.#runtimes.draining) {
      throw new RealtimeCommandFailure("server_restarting");
    }
  }

  async #queueAccepted(
    user: AuthenticatedUser,
    sessionId: string,
    input?: PromptInput,
  ): Promise<AgentSessionDetail> {
    this.#ensureAcceptingCommands();
    return this.#queueForUser(user, sessionId, input);
  }

  async continueForUser(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<AgentSessionDetail> {
    return this.#queueAccepted(user, sessionId);
  }

  deliverRunnerCommands(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void {
    this.#broker.deliverQueued(runnerId, deliver);
  }

  async drain(): Promise<void> {
    await this.#runtimes.drain();
  }

  async directories(request: Request, runnerId: string): Promise<Response> {
    return await this.#requests.directories(request, runnerId);
  }

  async createForUser(
    user: AuthenticatedUser,
    input: CreateSessionInput,
  ): Promise<AgentSessionDetail> {
    this.#ensureAcceptingCommands();
    return this.#createValidatedSession(user, input);
  }

  readForUser(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined {
    return this.#store.get(userId, sessionId);
  }

  summariesForUser(userId: string): readonly AgentSessionSummary[] {
    return this.#store.list(userId);
  }

  async messageForUser(
    user: AuthenticatedUser,
    sessionId: string,
    input: PromptInput,
  ): Promise<AgentSessionDetail> {
    return this.#queueAccepted(user, sessionId, input);
  }

  async modelsForUser(selection: {
    readonly credentialId: string;
    readonly provider: ProviderId;
    readonly user: AuthenticatedUser;
  }): Promise<AgentModelCatalog> {
    const { credentialId, provider, user } = selection;
    return this.#withCredentialAccess(
      user.id,
      { credentialId, provider },
      async (credential) => {
        try {
          return await this.#discoverModels(provider, credential);
        } catch {
          throw new RealtimeCommandFailure("provider_unavailable");
        }
      },
    );
  }

  onChange(listener: (userId: string, sessionId: string) => void): void {
    this.#onChange.add(listener);
  }

  runnerConnected(): void {
    this.#actions.reportAll(this.#store.pendingSpawnedSessions());
  }
  setAutoCompactionForUser(
    user: AuthenticatedUser,
    sessionId: string,
    autoCompact: boolean,
  ): AgentSessionDetail {
    const detail = this.#store.setAutoCompact(
      user.id,
      sessionId,
      autoCompact,
      this.#now(),
    );
    if (detail === undefined) {
      throw new RealtimeCommandFailure("not_found");
    }
    this.#notify(user.id, sessionId);
    return detail;
  }

  #requireDetail(userId: string, sessionId: string): AgentSessionDetail {
    const detail = this.#store.get(userId, sessionId);
    if (detail === undefined) {
      throw new RealtimeCommandFailure("not_found");
    }
    return detail;
  }

  stopForUser(user: AuthenticatedUser, sessionId: string): AgentSessionDetail {
    const existing = this.#requireDetail(user.id, sessionId);
    if (existing.status !== "stopped") {
      this.#store.stop(user.id, sessionId, this.#now());
    }
    this.#runtimes.abort(sessionId);
    this.#broker.cancelSession(sessionId);
    this.#notify(user.id, sessionId);
    return this.#requireDetail(user.id, sessionId);
  }

  readonly #notify = (userId: string, sessionId: string): void => {
    for (const listener of this.#onChange) {
      listener(userId, sessionId);
    }
  };

  async #withCredentialAccess<Result>(
    userId: string,
    selection: CredentialSelection,
    action: SessionAction<Result>,
  ): Promise<Result> {
    let credential: ProviderCredentialAccess | undefined;

    try {
      credential = await this.#providers[selection.provider].readCredential(
        userId,
        selection.credentialId,
      );
    } catch {
      throw new RealtimeCommandFailure("credential_refresh_failed");
    }

    if (credential === undefined) {
      throw new RealtimeCommandFailure("credential_unavailable");
    }
    return action(credential);
  }

  async #withRuntimeAccess<Result>(
    userId: string,
    selection: RuntimeSelection,
    action: SessionAction<Result>,
  ): Promise<Result> {
    if (!this.#runners.runnerIsAvailable(userId, selection.runnerId)) {
      throw new RealtimeCommandFailure("runner_unavailable");
    }

    return this.#withCredentialAccess(userId, selection, action);
  }

  async #createValidatedSession(
    user: AuthenticatedUser,
    input: CreateSessionInput,
  ): Promise<AgentSessionDetail> {
    return this.#withRuntimeAccess(user.id, input, async (credential) => {
      const selectedModel = selectedSessionModel(input, credential.source);
      let maxContextTokens: number | null = null;
      let providerPricing: AgentSessionSummary["providerPricing"] = null;

      try {
        const catalog = await this.#discoverModels(input.provider, credential);
        const model = catalog.models.find(({ id }) => id === selectedModel);
        maxContextTokens = model?.contextWindow ?? null;
        providerPricing = model?.pricing ?? null;
      } catch {
        // Model discovery enhances display but does not gate a session.
      }

      if (this.#runtimes.draining) {
        throw new RealtimeCommandFailure("server_restarting");
      }

      const detail = this.#store.create(
        {
          ...input,
          autoCompact: true,
          maxContextTokens,
          model: selectedModel,
          providerPricing,
          userId: user.id,
        },
        this.#now(),
      );
      this.#launch(detail, credential, user.id);
      this.#notify(user.id, detail.id);
      return detail;
    });
  }

  #launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    compact = false,
  ): boolean {
    return this.#runtimes.launch(detail.id, (controller) =>
      this.#run(detail, credential, userId, controller, compact),
    );
  }

  async #queueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    prompt?: PromptInput,
  ): Promise<AgentSessionDetail> {
    const existing = this.#store.get(user.id, sessionId);
    if (existing === undefined) {
      throw new RealtimeCommandFailure("not_found");
    }
    const unavailable = unavailableSessionError(existing);
    if (unavailable !== undefined) {
      throw new RealtimeCommandFailure(unavailable);
    }

    if (!this.#runners.runnerIsAvailable(user.id, existing.runnerId)) {
      throw new RealtimeCommandFailure("runner_unavailable");
    }

    return this.#withCredentialAccess(user.id, existing, (credential) => {
      const queued = this.#store.queue(
        user.id,
        existing.id,
        this.#now(),
        prompt === undefined
          ? undefined
          : { content: prompt.prompt, images: prompt.images },
      );

      if (queued.status !== "queued") {
        throw new RealtimeCommandFailure(
          queued.status === "busy" ? "session_busy" : "not_found",
        );
      }

      this.#launch(queued.detail, credential, user.id);
      this.#notify(user.id, sessionId);
      return queued.detail;
    });
  }

  #notifyFinished(detail: AgentSessionDetail, userId: string): void {
    this.#notify(userId, detail.id);
    this.#actions.finished(detail, userId);
  }

  #finish(detail: AgentSessionDetail, userId: string, error?: unknown): void {
    const current = this.#store.get(userId, detail.id);
    if (current?.status === "stopped") {
      this.#notifyFinished(detail, userId);
      return;
    }
    if (error !== undefined) {
      this.#store.appendErrorMessage(
        detail.id,
        safeErrorMessage(error),
        this.#now(),
      );
    }
    this.#store.mark(
      detail.id,
      error === undefined ? "idle" : "failed",
      this.#now(),
    );
    this.#notifyFinished(detail, userId);
  }

  async #run(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    userId: string,
    controller: AbortController,
    compact: boolean,
  ): Promise<void> {
    if (!this.#store.mark(detail.id, "running", this.#now())) {
      return;
    }
    this.#notify(userId, detail.id);

    try {
      const runtime = sessionModelRuntime(
        {
          actions: this.#actions,
          braveSearch: this.#braveSearch,
          broker: this.#broker,
          modelFactory: this.#modelFactory,
          now: this.#now,
          notify: this.#notify,
          realtime: this.#realtime,
          store: this.#store,
        },
        detail,
        credential,
        userId,
        controller,
      );
      await (compact
        ? compactSessionConversation(runtime)
        : runSessionAgent(runtime));
      this.#finish(detail, userId);
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) {
        this.#finish(detail, userId, error);
      }
    }
  }
}

export function createSessionIntegration(
  auth: GoogleAuth,
  runners: RunnerIntegration,
  providers: SessionCredentialReaders,
  dependencies: SessionDependencies,
): SessionIntegration {
  return new DrizzleSessionIntegration(auth, runners, providers, dependencies);
}
