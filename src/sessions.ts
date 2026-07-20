import {
  defaultAgentModel,
  isAgentModelId,
  isAgentReasoningEffort,
  type AgentReasoningEffort,
} from "./agent-configuration.ts";
import { runAgentLoop, type AgentModel } from "./agent-loop.ts";
import {
  discoverAgentModels,
  type AgentModelDiscoverer,
} from "./agent-model-discovery.ts";
import {
  ChatCompletionsAgentModel,
  type AgentProviderCredential,
} from "./agent-model.ts";
import { createAgentSystemPrompt } from "./agent-prompt.ts";
import { isRecord, type AuthenticatedUser } from "./auth-model.ts";
import type { GoogleAuth } from "./auth.ts";
import type { AppDatabase } from "./database.ts";
import { createDatabase } from "./database.ts";
import {
  createApiError,
  createJsonResponse,
  createMethodNotAllowedResponse,
  createNoContentResponse,
  parseJsonRequest,
} from "./http.ts";
import { createUuidV7, type IdGenerator } from "./ids.ts";
import type {
  ProviderCredentialAccess,
  ProviderId,
} from "./provider-credential-store.ts";
import {
  RunnerCommandBroker,
  type DispatchRunnerToolCommand,
} from "./runner-command-broker.ts";
import { MAXIMUM_RUNNER_PATH_LENGTH } from "./runner-directory-model.ts";
import type { RunnerIntegration } from "./runners.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import type { AgentSessionDetail } from "./session-model.ts";
import {
  SessionRequestHelpers,
  readIdentifier,
  readStringField,
  withRequestMethod,
} from "./session-request-helpers.ts";
import { SessionRuntimes } from "./session-runtime.ts";
import { SessionStore, type CreateAgentSession } from "./session-store.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;
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

type SessionAction = (
  credential: ProviderCredentialAccess,
) => Promise<Response> | Response;

interface AgentModelFactoryOptions {
  readonly credential: AgentProviderCredential;
  readonly model: string;
  readonly provider: ProviderId;
  readonly reasoningEffort: AgentReasoningEffort | null;
  readonly systemPrompt: string;
}

type AgentModelFactory = (options: AgentModelFactoryOptions) => AgentModel;

interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly database?: AppDatabase;
  readonly discoverModels?: AgentModelDiscoverer;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
}

type CreateSessionInput = Omit<
  CreateAgentSession,
  "maxContextTokens" | "userId"
>;

interface CredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

interface RuntimeSelection extends CredentialSelection {
  readonly runnerId: string;
}

export interface SessionIntegration {
  collection(request: Request): Promise<Response>;
  continue(request: Request, sessionId: string): Promise<Response>;
  directories(request: Request, runnerId: string): Promise<Response>;
  drain(): Promise<void>;
  item(request: Request, sessionId: string): Response;
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  stop(request: Request, sessionId: string): Promise<Response>;
  work(request: Request): Response;
  workResult(request: Request, commandId: string): Promise<Response>;
}

function readProvider(value: unknown): ProviderId | undefined {
  return value === "openai" || value === "openrouter" ? value : undefined;
}

function readCreateSession(value: unknown): CreateSessionInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const credentialId = readIdentifier(value["credentialId"]);
  const provider = readProvider(value["provider"]);
  const runnerId = readIdentifier(value["runnerId"]);
  const prompt = readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
  const workingDirectory = readStringField(
    value,
    "workingDirectory",
    MAXIMUM_RUNNER_PATH_LENGTH,
    { trim: true },
  );
  const modelValue = value["model"];
  const reasoningEffortValue = value["reasoningEffort"];

  if (
    credentialId === undefined ||
    provider === undefined ||
    runnerId === undefined ||
    prompt === undefined ||
    workingDirectory === undefined ||
    workingDirectory.includes("\0") ||
    (modelValue !== undefined && !isAgentModelId(modelValue)) ||
    (reasoningEffortValue !== undefined &&
      !isAgentReasoningEffort(reasoningEffortValue))
  ) {
    return undefined;
  }

  return {
    credentialId,
    model: typeof modelValue === "string" ? modelValue : "",
    prompt,
    provider,
    reasoningEffort: isAgentReasoningEffort(reasoningEffortValue)
      ? reasoningEffortValue
      : null,
    runnerId,
    workingDirectory,
  };
}

function readPrompt(value: unknown): string | undefined {
  return readStringField(value, "prompt", MAXIMUM_PROMPT_LENGTH, {
    trim: true,
  });
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
  readonly #discoverModels: AgentModelDiscoverer;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #providers: SessionCredentialReaders;
  readonly #requests: SessionRequestHelpers;
  readonly #runners: RunnerIntegration;
  readonly #runtimes = new SessionRuntimes();
  readonly #store: SessionStore;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
    this.#broker = dependencies.broker ?? new RunnerCommandBroker();
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
    this.#store.failInterrupted(this.#now());
  }

  async collection(request: Request): Promise<Response> {
    return this.#requests.forUser(request, (user) =>
      this.#collectionForUser(request, user),
    );
  }

  async continue(request: Request, sessionId: string): Promise<Response> {
    return await this.#resume(request, sessionId);
  }

  drain(): Promise<void> {
    return this.#runtimes.drain();
  }

  async directories(request: Request, runnerId: string): Promise<Response> {
    return await this.#requests.directories(request, runnerId);
  }

  item(request: Request, sessionId: string): Response {
    return this.#requests.authenticate(request, "GET", (user) =>
      this.#detailResponse(user.id, sessionId),
    );
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

  async stop(request: Request, sessionId: string): Promise<Response> {
    return this.#requests.postForUser(request, (user) =>
      this.#withStoredSession(user, sessionId, (existing) => {
        if (existing.status !== "stopped") {
          this.#store.stop(user.id, sessionId, this.#now());
        }

        this.#runtimes.abort(sessionId);
        this.#broker.cancelSession(sessionId);
        return this.#detailResponse(user.id, sessionId);
      }),
    );
  }

  work(request: Request): Response {
    return this.#withRunner(request, (runnerId) =>
      withRequestMethod(request, "POST", () => {
        const command = this.#broker.take(runnerId);
        return command === undefined
          ? createNoContentResponse()
          : createJsonResponse({ command });
      }),
    );
  }

  workResult(request: Request, commandId: string): Promise<Response> {
    return Promise.resolve(
      this.#withRunner(request, (runnerId) => {
        switch (request.method) {
          case "GET":
            return createJsonResponse({
              active: this.#broker.isActive(runnerId, commandId),
            });
          case "POST":
            return this.#requests.recordWorkResult(
              request,
              runnerId,
              commandId,
            );
          default:
            return createMethodNotAllowedResponse("GET, POST");
        }
      }),
    );
  }

  #withStoredSession(
    user: AuthenticatedUser,
    sessionId: string,
    action: (session: AgentSessionDetail) => Promise<Response> | Response,
  ): Promise<Response> | Response {
    const session = this.#store.get(user.id, sessionId);
    return session === undefined
      ? createApiError("not_found", 404)
      : action(session);
  }

  async #withCredentialAccess(
    userId: string,
    selection: CredentialSelection,
    action: SessionAction,
  ): Promise<Response> {
    let credential: ProviderCredentialAccess | undefined;

    try {
      credential = await this.#providers[selection.provider].readCredential(
        userId,
        selection.credentialId,
      );
    } catch {
      return createApiError("credential_refresh_failed", 502);
    }

    return credential === undefined
      ? createApiError("credential_unavailable", 409)
      : action(credential);
  }

  async #withRuntimeAccess(
    userId: string,
    selection: RuntimeSelection,
    action: SessionAction,
  ): Promise<Response> {
    if (!this.#runners.runnerIsAvailable(userId, selection.runnerId)) {
      return createApiError("runner_unavailable", 409);
    }

    return this.#withCredentialAccess(userId, selection, action);
  }

  #detailResponse(userId: string, sessionId: string): Response {
    const detail = this.#store.get(userId, sessionId);
    return detail === undefined
      ? createApiError("not_found", 404)
      : createJsonResponse(detail);
  }

  #withRunner<Result>(
    request: Request,
    action: (runnerId: string) => Result,
  ): Response | Result {
    const runner = this.#runners.authenticatedRunner(request);
    return runner === undefined
      ? createApiError("invalid_token", 401)
      : action(runner.id);
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
      const selectedModel =
        input.model.length === 0
          ? defaultAgentModel(input.provider, credential.source)
          : input.model;
      let maxContextTokens: number | null = null;

      try {
        const catalog = await this.#discoverModels(input.provider, credential);
        maxContextTokens =
          catalog.models.find(({ id }) => id === selectedModel)
            ?.contextWindow ?? null;
      } catch {
        // Model discovery enhances context display but does not gate a session.
      }

      if (this.#runtimes.draining) {
        return createApiError("server_restarting", 503);
      }

      const detail = this.#store.create(
        { ...input, maxContextTokens, model: selectedModel, userId: user.id },
        this.#now(),
      );
      this.#launch(detail, credential);
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
    const prompt = await parseJsonRequest(request, readPrompt);
    return prompt === undefined
      ? createApiError("invalid_request", 400)
      : this.#queueForUser(user, sessionId, prompt);
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
    prompt?: string,
  ): Promise<Response> {
    const existing = this.#store.get(user.id, sessionId);
    if (existing === undefined) {
      return createApiError("not_found", 404);
    }

    if (!this.#runners.runnerIsAvailable(user.id, existing.runnerId)) {
      return createApiError("runner_unavailable", 409);
    }

    return this.#withCredentialAccess(user.id, existing, (credential) => {
      const queued = this.#store.queue(
        user.id,
        existing.id,
        this.#now(),
        prompt,
      );

      if (queued.status !== "queued") {
        return createApiError(
          queued.status === "busy" ? "session_busy" : "not_found",
          queued.status === "busy" ? 409 : 404,
        );
      }

      this.#launch(queued.detail, credential);
      return createJsonResponse(queued.detail, 202);
    });
  }

  #launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
  ): void {
    this.#runtimes.launch(detail.id, (controller) =>
      this.#run(detail, credential, controller),
    );
  }

  async #run(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
    controller: AbortController,
  ): Promise<void> {
    if (!this.#store.mark(detail.id, "running", this.#now())) {
      return;
    }

    try {
      const agentFile = await loadSessionAgentFile(
        this.#broker,
        detail,
        controller.signal,
      );

      this.#store.setAgentFile(detail.id, agentFile, this.#now());

      const model = this.#modelFactory({
        credential,
        model: detail.model,
        provider: detail.provider,
        reasoningEffort: detail.reasoningEffort,
        systemPrompt: createAgentSystemPrompt(agentFile),
      });
      await runAgentLoop({
        executeTool: (call) => {
          const command: DispatchRunnerToolCommand = {
            arguments: call.arguments,
            runnerId: detail.runnerId,
            sessionId: detail.id,
            tool: call.name,
            workingDirectory: detail.workingDirectory,
          };
          return this.#broker.dispatch(command, controller.signal);
        },
        initialMessages: this.#store.conversation(detail.id),
        model,
        recordContextTokens: (tokens) => {
          this.#store.updateContextTokens(detail.id, tokens, this.#now());
        },
        recordMessage: (message) => {
          this.#store.appendAgentMessage(detail.id, message, this.#now());
        },
        signal: controller.signal,
      });
      this.#store.mark(detail.id, "idle", this.#now());
    } catch (error) {
      if (!controller.signal.aborted && !isAbort(error)) {
        this.#store.appendSystemMessage(
          detail.id,
          safeErrorMessage(error),
          this.#now(),
        );
        this.#store.mark(detail.id, "failed", this.#now());
      }
    }
  }
}

export function createSessionIntegration(
  auth: GoogleAuth,
  runners: RunnerIntegration,
  providers: SessionCredentialReaders,
  dependencies: SessionDependencies = {},
): SessionIntegration {
  return new DrizzleSessionIntegration(auth, runners, providers, dependencies);
}
