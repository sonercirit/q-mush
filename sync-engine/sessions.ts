import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7, type IdGenerator } from "../shared/ids.ts";
import type { ProviderCredentialAccess } from "../shared/provider-credential-store.ts";
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
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import {
  startManualSessionCompaction,
  updateSessionCompactionMode,
} from "./session-compaction-actions.ts";
import {
  readSessionCredential,
  withSessionCredential,
  type SessionCredentialAction,
  type SessionCredentialReaders,
  type SessionCredentialSelection,
  type SessionRuntimeSelection,
} from "./session-credential-access.ts";
import {
  readCreateSession,
  readPrompt,
  readProvider,
  selectedSessionModel,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import type { SessionIntegration } from "./session-integration.ts";
import { sessionModelRuntime } from "./session-model-runtime.ts";
import { reassignSessionRequest } from "./session-reassignment-request.ts";
import {
  SessionRequestHelpers,
  readIdentifier,
} from "./session-request-helpers.ts";
import { RunnerRemovalCoordinator } from "./session-runner-removal.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import {
  storedSessionResponse,
  withStoredSession,
} from "./session-store-access.ts";
import { SessionStore } from "./session-store.ts";

export type { SessionCredentialReaders } from "./session-credential-access.ts";
export type { SessionIntegration } from "./session-integration.ts";

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

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class DrizzleSessionIntegration implements SessionIntegration {
  readonly #broker: RunnerCommandBroker;
  readonly #auth: GoogleAuth;
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
  readonly #runnerRemoval: RunnerRemovalCoordinator;
  readonly #store: SessionStore;
  readonly #actions: SessionAgentActions;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
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
    this.#modelFactory =
      dependencies.modelFactory ??
      ((options) => new ChatCompletionsAgentModel(options));
    this.#now = dependencies.now ?? Date.now;
    this.#providers = providers;
    this.#requests = new SessionRequestHelpers(auth, this.#broker, runners);
    this.#runners = runners;
    this.#store = new SessionStore(
      database,
      dependencies.randomId ?? createUuidV7,
    );
    this.#runnerRemoval = new RunnerRemovalCoordinator({
      broker: this.#broker,
      now: this.#now,
      notify: this.#notify,
      runtimes: this.#runtimes,
      store: this.#store,
    });
    this.#actions = this.#createActions(database);
    this.#runners.onRemovalFailed((userId, runnerId) => {
      this.#runnerRemoval.failed(userId, runnerId);
    });
    this.#runners.onRemoving((userId, runnerId) => {
      this.#runnerRemoval.removing(userId, runnerId);
    });
    this.#runners.onRemoved((userId, runnerId) =>
      this.#runnerRemoval.removed(userId, runnerId),
    );
    this.#actions.reportAll(this.#store.failInterrupted(this.#now()));
  }

  #runnerIsAvailable(userId: string, runnerId: string): boolean {
    return this.#runners.runnerIsAvailable(userId, runnerId);
  }

  #createActions(database: AppDatabase): SessionAgentActions {
    return new SessionAgentActions({
      activeSession: (sessionId) => this.#runtimes.active(sessionId),
      abortSession: (sessionId) => {
        this.#runtimes.abort(sessionId);
      },
      broker: this.#broker,
      browseDirectories: (userId, runnerId, path) =>
        this.#requests.browseDirectories(userId, runnerId, path),
      database,
      discoverModels: this.#discoverModels,
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
      listOnlineRunners: (userId) => this.#runners.onlineForUser(userId),
      listRunnerOptions: (userId, offset, limit, search) =>
        this.#runners.listOnlineForUser(userId, {
          limit,
          offset,
          ...(search === undefined ? {} : { search }),
        }),
      notify: this.#notify,
      now: this.#now,
      readCredential: (userId, selection) =>
        this.#readCredential(userId, selection),
      runnerIsAvailable: (userId, runnerId) =>
        this.#runnerIsAvailable(userId, runnerId),
      store: this.#store,
      withCredential: (userId, selection, action) =>
        this.#withCredentialAccess(userId, selection, action),
    });
  }

  collection(request: Request): Response | Promise<Response> {
    return this.#requests.forUser(request, (user) =>
      this.#collectionForUser(request, user),
    );
  }

  async compact(request: Request, sessionId: string): Promise<Response> {
    return await Promise.resolve(
      this.#requests.postForUser(request, (user) =>
        this.#compactForUser(user, sessionId),
      ),
    );
  }

  async compaction(request: Request, sessionId: string): Promise<Response> {
    return updateSessionCompactionMode(
      {
        auth: this.#auth,
        now: this.#now,
        onChanged: (detail, userId) => {
          this.#notify(userId, detail.id);
        },
        store: this.#store,
      },
      request,
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

  async continue(request: Request, sessionId: string): Promise<Response> {
    return await this.#resume(request, sessionId);
  }

  deliverRunnerCommands(
    runnerId: string,
    deliver: (command: RunnerToolCommand) => boolean,
  ): void {
    this.#broker.deliverQueued(runnerId, deliver);
  }

  drain(): Promise<void> {
    return this.#runtimes.drain();
  }

  async directories(request: Request, runnerId: string): Promise<Response> {
    return await this.#requests.directories(request, runnerId);
  }

  detailForUser(
    userId: string,
    sessionId: string,
  ): AgentSessionDetail | undefined {
    return this.#store.get(userId, sessionId);
  }

  item(request: Request, sessionId: string): Response {
    return this.#requests.authenticate(request, "GET", (user) =>
      storedSessionResponse(this.#store, user.id, sessionId),
    );
  }

  listForUser(userId: string): readonly AgentSessionSummary[] {
    return this.#store.list(userId);
  }

  message(request: Request, sessionId: string): Promise<Response> {
    return Promise.resolve(
      this.#requests.authenticate(request, "POST", (user) =>
        this.#messageForUser(request, user, sessionId),
      ),
    );
  }

  models(request: Request): Promise<Response> {
    const response =
      request.method === "GET"
        ? this.#requests.forUser(request, (user) =>
            this.#modelsForUser(request, user),
          )
        : createMethodNotAllowedResponse("GET");
    return Promise.resolve(response);
  }

  onChange(listener: (userId: string, sessionId: string) => void): void {
    this.#onChange.add(listener);
  }

  async reassign(request: Request, sessionId: string): Promise<Response> {
    return reassignSessionRequest(
      {
        authenticate: this.#requests.authenticate,
        notify: this.#notify,
        now: this.#now,
        store: this.#store,
      },
      request,
      sessionId,
    );
  }

  runnerConnected(): void {
    this.#actions.reportAll(this.#store.pendingSpawnedSessions());
  }

  async runnerRemoved(userId: string, runnerId: string): Promise<void> {
    await this.#runnerRemoval.removed(userId, runnerId);
  }

  async stop(request: Request, sessionId: string): Promise<Response> {
    return this.#requests.postForUser(request, (user) =>
      withStoredSession(this.#store, user.id, sessionId, (existing) => {
        if (existing.status !== "stopped") {
          this.#store.stop(user.id, sessionId, this.#now());
        }

        this.#runtimes.abort(sessionId);
        this.#broker.cancelSession(sessionId);
        this.#notify(user.id, sessionId);
        return storedSessionResponse(this.#store, user.id, sessionId);
      }),
    );
  }

  readonly #notify = (userId: string, sessionId: string): void => {
    for (const listener of this.#onChange) {
      listener(userId, sessionId);
    }
  };

  async #readCredential(
    userId: string,
    selection: SessionCredentialSelection,
  ): Promise<ProviderCredentialAccess | undefined> {
    return readSessionCredential(this.#providers, userId, selection);
  }

  #withCredentialAccess(
    userId: string,
    selection: SessionCredentialSelection,
    action: SessionCredentialAction,
  ): Promise<Response> {
    return withSessionCredential(this.#providers, userId, selection, action);
  }

  async #withRuntimeAccess(
    userId: string,
    selection: SessionRuntimeSelection,
    action: SessionCredentialAction,
  ): Promise<Response> {
    return this.#runners.runnerIsAvailable(userId, selection.runnerId)
      ? this.#withCredentialAccess(userId, selection, action)
      : createApiError("runner_unavailable", 409);
  }

  #collectionForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> | Response {
    switch (request.method) {
      case "GET":
        return createJsonResponse({ sessions: this.#store.list(user.id) });
      case "POST":
        return this.#runtimes.draining
          ? createApiError("server_restarting", 503)
          : this.#createForUser(request, user);
      default:
        return createMethodNotAllowedResponse("GET, POST");
    }
  }

  async #modelsForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    const search = new URL(request.url).searchParams;
    const credentialId = readIdentifier(search.get("credentialId"));
    const provider = readProvider(search.get("provider"));

    if (credentialId === undefined || provider === undefined) {
      return createApiError("invalid_request", 400);
    }

    return this.#withCredentialAccess(
      user.id,
      { credentialId, provider },
      async (credential) => {
        try {
          return createJsonResponse(
            await this.#discoverModels(provider, credential),
          );
        } catch {
          return createApiError("provider_unavailable", 502);
        }
      },
    );
  }

  async #createForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> {
    const input = await parseJsonRequest(request, readCreateSession);
    return input === undefined
      ? createApiError("invalid_request", 400)
      : this.#createValidatedSession(user, input);
  }

  async #createValidatedSession(
    user: AuthenticatedUser,
    input: CreateSessionInput,
  ): Promise<Response> {
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
        return createApiError("server_restarting", 503);
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
      return createJsonResponse(detail, 201);
    });
  }

  async #messageForUser(
    request: Request,
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<Response> {
    if (this.#runtimes.draining) {
      return createApiError("server_restarting", 503);
    }
    const input = await parseJsonRequest(request, readPrompt);
    return input === undefined
      ? createApiError("invalid_request", 400)
      : this.#queueForUser(user, sessionId, input);
  }

  async #compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
  ): Promise<Response> {
    return startManualSessionCompaction(
      {
        credential: (userId, detail, action) =>
          this.#withCredentialAccess(userId, detail, action),
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

  #resume(request: Request, sessionId: string): Promise<Response> | Response {
    return this.#requests.postForUser(request, (user) =>
      this.#runtimes.draining
        ? createApiError("server_restarting", 503)
        : this.#queueForUser(user, sessionId),
    );
  }

  async #queueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    prompt?: PromptInput,
  ): Promise<Response> {
    const existing = this.#store.get(user.id, sessionId);
    const unavailable = unavailableSessionResponse(existing);
    if (unavailable !== undefined || existing === undefined) {
      return unavailable ?? createApiError("not_found", 404);
    }

    if (!this.#runners.runnerIsAvailable(user.id, existing.runnerId)) {
      return createApiError("runner_unavailable", 409);
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
        return createApiError(
          queued.status === "busy" ? "session_busy" : "not_found",
          queued.status === "busy" ? 409 : 404,
        );
      }

      this.#launch(queued.detail, credential, user.id);
      this.#notify(user.id, sessionId);
      return createJsonResponse(queued.detail, 202);
    });
  }

  #notifyFinished(detail: AgentSessionDetail, userId: string): void {
    this.#notify(userId, detail.id);
    this.#actions.finished(detail, userId);
  }

  #finish(detail: AgentSessionDetail, userId: string, error?: unknown): void {
    const current = this.#store.get(userId, detail.id);
    if (current?.runnerRequired === true || current?.status === "stopped") {
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
