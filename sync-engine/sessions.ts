import type { AuthenticatedUser } from "../shared/auth-model.ts";
import { createDatabase, type AppDatabase } from "../shared/database.ts";
import { createUuidV7 } from "../shared/ids.ts";
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
import type { BraveSearchExecutor } from "./brave-search.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  parseJsonRequest,
} from "./http.ts";
import type { RealtimeHub } from "./realtime-hub.ts";
import type { RunnerIntegration } from "./runners.ts";
import {
  SessionAccess,
  type SessionCredentialReaders,
  type SessionDependencies,
  type SessionIntegration,
} from "./session-access.ts";
import { SessionAgentActions } from "./session-agent-actions.ts";
import type { AgentModelFactory } from "./session-agent-models.ts";
import {
  compactSessionConversation,
  runSessionAgent,
} from "./session-agent-runtime.ts";
import { unavailableSessionResponse } from "./session-availability.ts";
import { startManualSessionCompaction } from "./session-compaction-actions.ts";
import { updateStoredSessionCompactionMode } from "./session-compaction-mode.ts";
import { launchCreatedSession } from "./session-create.ts";
import {
  readCreateSession,
  readPrompt,
  readProvider,
  type CreateSessionInput,
  type PromptInput,
} from "./session-input.ts";
import { sessionModelRuntime } from "./session-model-runtime.ts";
import {
  SessionRequestHelpers,
  readIdentifier,
} from "./session-request-helpers.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import { SessionStore } from "./session-store.ts";
import {
  requestSessionWorkspaceId,
  storedSessionResponse,
  withRequestSessionWorkspace,
  withStoredWorkspaceSession,
} from "./session-workspace.ts";

export type { SessionCredentialReaders, SessionIntegration };

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

class DrizzleSessionIntegration implements SessionIntegration {
  readonly #access: SessionAccess;
  readonly #broker: RunnerCommandBroker;
  readonly #auth: GoogleAuth;
  readonly #braveSearch: BraveSearchExecutor;
  readonly #discoverModels: AgentModelDiscoverer;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #onChange = new Set<(userId: string, sessionId: string) => void>();
  readonly #realtime: RealtimeHub | undefined;
  readonly #requests: SessionRequestHelpers;
  readonly #runners: RunnerIntegration;
  readonly #runtimes = new SessionRuntimes();
  readonly #store: SessionStore;
  readonly #workspaces: NonNullable<SessionDependencies["workspaces"]>;
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
    this.#workspaces =
      dependencies.workspaces ??
      ({
        defaultForUser: () => undefined,
        exists: () => true,
      } satisfies NonNullable<SessionDependencies["workspaces"]>);
    this.#access = new SessionAccess(providers, runners, this.#workspaces);
    this.#requests = new SessionRequestHelpers(auth, this.#broker, runners);
    this.#runners = runners;
    this.#store = new SessionStore(
      database,
      dependencies.randomId ?? createUuidV7,
    );
    this.#actions = this.#createActions(database, providers);
    this.#actions.reportAll(this.#store.failInterrupted(this.#now()));
  }

  #createActions(
    database: AppDatabase,
    providers: SessionCredentialReaders,
  ): SessionAgentActions {
    return new SessionAgentActions({
      activeSession: (sessionId) => this.#runtimes.active(sessionId),
      abortSession: (sessionId) => {
        this.#runtimes.abort(sessionId);
      },
      broker: this.#broker,
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
      listRunnerOptions: (userId, offset, limit, workspaceId, search) =>
        this.#runners.listOnlineForUser(
          userId,
          {
            limit,
            offset,
            ...(search === undefined ? {} : { search }),
          },
          workspaceId,
        ),
      notify: this.#notify,
      now: this.#now,
      readCredential: (userId, selection) =>
        Promise.resolve(
          providers[selection.provider].readCredential(
            userId,
            selection.credentialId,
            selection.workspaceId,
          ),
        ),
      runnerIsAvailable: (userId, runnerId, workspaceId) =>
        this.#runners.runnerIsAvailable(userId, runnerId, workspaceId),
      store: this.#store,
      withCredential: (userId, selection, action) =>
        this.#access.credential(userId, selection, action),
    });
  }

  collection(request: Request): Response | Promise<Response> {
    return this.#requests.forUser(request, (user) =>
      this.#collectionForUser(request, user),
    );
  }

  async compact(request: Request, sessionId: string): Promise<Response> {
    return Promise.resolve(
      this.#requests.postForUser(request, (user) =>
        withRequestSessionWorkspace(
          request,
          user,
          this.#workspaces,
          (workspaceId) => this.#compactForUser(user, sessionId, workspaceId),
        ),
      ),
    );
  }

  async compaction(request: Request, sessionId: string): Promise<Response> {
    if (request.method !== "POST") {
      return createMethodNotAllowedResponse("POST");
    }
    const user = this.#auth.authenticatedUser(request);
    if (user === null) {
      return createApiError("unauthorized", 401);
    }
    return updateStoredSessionCompactionMode(
      {
        auth: this.#auth,
        notify: this.#notify,
        now: this.#now,
        store: this.#store,
        workspaces: this.#workspaces,
      },
      request,
      sessionId,
      user,
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
    return Promise.resolve(this.#resume(request, sessionId));
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

  async directories(
    request: Request,
    runnerId: string,
    workspaceId?: string | null,
  ): Promise<Response> {
    const user = this.#auth.authenticatedUser(request);
    if (user === null) {
      return createApiError("unauthorized", 401);
    }
    if (workspaceId === null) {
      return createApiError("invalid_request", 400);
    }
    const selectedWorkspaceId =
      workspaceId ?? this.#workspaces.defaultForUser(user.id)?.id;
    if (
      selectedWorkspaceId === undefined ||
      !this.#workspaces.exists(user.id, selectedWorkspaceId)
    ) {
      return createApiError("workspace_unavailable", 409);
    }
    return this.#requests.directories(request, runnerId, selectedWorkspaceId);
  }

  detailForUser(
    userId: string,
    sessionId: string,
    workspaceId: string,
  ): AgentSessionDetail | undefined {
    return this.#store.get(userId, sessionId, workspaceId);
  }

  item(request: Request, sessionId: string): Response {
    return this.#requests.authenticate(request, "GET", (user) => {
      const workspaceId = requestSessionWorkspaceId(
        request,
        user.id,
        this.#workspaces,
      );
      return workspaceId === undefined
        ? createApiError("workspace_unavailable", 409)
        : storedSessionResponse(this.#store, user.id, sessionId, workspaceId);
    });
  }

  listForUser(
    userId: string,
    workspaceId: string,
  ): readonly AgentSessionSummary[] {
    return this.#store.list(userId, workspaceId);
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

  runnerConnected(): void {
    this.#actions.reportAll(this.#store.pendingSpawnedSessions());
  }
  async stop(request: Request, sessionId: string): Promise<Response> {
    return this.#requests.postForUser(request, (user) =>
      withRequestSessionWorkspace(
        request,
        user,
        this.#workspaces,
        (workspaceId) =>
          withStoredWorkspaceSession(
            this.#store,
            user,
            sessionId,
            workspaceId,
            (existing) => {
              if (existing.status !== "stopped") {
                this.#store.stop(user.id, sessionId, this.#now());
              }
              this.#runtimes.abort(sessionId);
              this.#broker.cancelSession(sessionId);
              this.#notify(user.id, sessionId);
              return storedSessionResponse(
                this.#store,
                user.id,
                sessionId,
                workspaceId,
              );
            },
          ),
      ),
    );
  }

  readonly #notify = (userId: string, sessionId: string): void => {
    for (const listener of this.#onChange) {
      listener(userId, sessionId);
    }
  };

  #collectionForUser(
    request: Request,
    user: AuthenticatedUser,
  ): Promise<Response> | Response {
    switch (request.method) {
      case "GET":
        return withRequestSessionWorkspace(
          request,
          user,
          this.#workspaces,
          (workspaceId) =>
            createJsonResponse({
              sessions: this.#store.list(user.id, workspaceId),
            }),
        );
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
    const workspaceId =
      readIdentifier(search.get("workspaceId")) ??
      this.#workspaces.defaultForUser(user.id)?.id;

    if (
      credentialId === undefined ||
      provider === undefined ||
      workspaceId === undefined ||
      !this.#workspaces.exists(user.id, workspaceId)
    ) {
      return createApiError("invalid_request", 400);
    }

    return this.#access.credential(
      user.id,
      { credentialId, provider, workspaceId },
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
    const workspaceId = input.workspaceId;
    if (!this.#workspaces.exists(user.id, workspaceId)) {
      return createApiError("workspace_unavailable", 409);
    }
    const scopedInput: CreateSessionInput & { readonly workspaceId: string } =
      input;
    const launchWithCredential = (credential: ProviderCredentialAccess) =>
      launchCreatedSession(
        {
          discoverModels: this.#discoverModels,
          draining: () => this.#runtimes.draining,
          launch: (detail, selectedCredential, userId) =>
            this.#launch(detail, selectedCredential, userId),
          notify: this.#notify,
          now: this.#now,
          store: this.#store,
        },
        user,
        scopedInput,
        credential,
      );
    return this.#access.runtime(user.id, scopedInput, launchWithCredential);
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
      : withRequestSessionWorkspace(
          request,
          user,
          this.#workspaces,
          (workspaceId) =>
            this.#queueForUser(user, sessionId, workspaceId, input),
        );
  }

  async #compactForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
  ): Promise<Response> {
    return startManualSessionCompaction(
      {
        credential: (userId, detail, action) =>
          this.#access.credential(userId, detail, action),
        launch: (detail, credential, userId) => {
          this.#launch(detail, credential, userId, true);
        },
        notify: this.#notify,
        now: this.#now,
        runtimes: this.#runtimes,
        store: this.#store,
        workspaceId,
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
    return this.#requests.postForUser(request, (user) => {
      if (this.#runtimes.draining) {
        return createApiError("server_restarting", 503);
      }
      return withRequestSessionWorkspace(
        request,
        user,
        this.#workspaces,
        (workspaceId) => this.#queueForUser(user, sessionId, workspaceId),
      );
    });
  }

  async #queueForUser(
    user: AuthenticatedUser,
    sessionId: string,
    workspaceId: string,
    prompt?: PromptInput,
  ): Promise<Response> {
    const existing = this.#store.get(user.id, sessionId, workspaceId);
    const unavailable = unavailableSessionResponse(existing);
    if (unavailable !== undefined || existing === undefined) {
      return unavailable ?? createApiError("not_found", 404);
    }

    if (
      !this.#runners.runnerIsAvailable(
        user.id,
        existing.runnerId,
        existing.workspaceId,
      )
    ) {
      return createApiError("runner_unavailable", 409);
    }

    return this.#access.credential(user.id, existing, (credential) => {
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
