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
import { withAuthenticatedUser } from "./authenticated-request.ts";
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
import {
  MAXIMUM_RUNNER_PATH_LENGTH,
  readRunnerDirectoryListing,
  RUNNER_DIRECTORY_COMMAND,
} from "./runner-directory-model.ts";
import type { RunnerIntegration } from "./runners.ts";
import { loadSessionAgentFile } from "./session-agent-file.ts";
import type { AgentSessionDetail } from "./session-model.ts";
import { SessionStore, type CreateAgentSession } from "./session-store.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;
const DIRECTORY_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
const MAXIMUM_RESULT_LENGTH = 512 * 1_024;
const IDENTIFIER_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;

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

type CreateSessionInput = Omit<CreateAgentSession, "userId">;

interface CredentialSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
}

interface RuntimeSelection extends CredentialSelection {
  readonly runnerId: string;
}

export interface SessionIntegration {
  collection(request: Request): Promise<Response>;
  directories(request: Request, runnerId: string): Promise<Response>;
  item(request: Request, sessionId: string): Response;
  message(request: Request, sessionId: string): Promise<Response>;
  models(request: Request): Promise<Response>;
  stop(request: Request, sessionId: string): Promise<Response>;
  work(request: Request): Response;
  workResult(request: Request, commandId: string): Promise<Response>;
}

function readIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

function readProvider(value: unknown): ProviderId | undefined {
  return value === "openai" || value === "openrouter" ? value : undefined;
}

function readStringField(
  value: unknown,
  key: string,
  maximumLength: number,
  options: { readonly allowEmpty?: boolean; readonly trim?: boolean } = {},
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];

  if (typeof field !== "string" || field.length > maximumLength) {
    return undefined;
  }

  const normalized = options.trim === true ? field.trim() : field;
  return options.allowEmpty === true || normalized.length > 0
    ? normalized
    : undefined;
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

function readToolOutput(value: unknown): string | undefined {
  return readStringField(value, "output", MAXIMUM_RESULT_LENGTH, {
    allowEmpty: true,
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return `Session failed: ${message.slice(0, 500)}`;
}

function withRequestMethod<Result>(
  request: Request,
  method: string,
  action: () => Result,
): Response | Result {
  return request.method === method
    ? action()
    : createMethodNotAllowedResponse(method);
}

class DrizzleSessionIntegration implements SessionIntegration {
  readonly #auth: GoogleAuth;
  readonly #broker: RunnerCommandBroker;
  readonly #discoverModels: AgentModelDiscoverer;
  readonly #modelFactory: AgentModelFactory;
  readonly #now: () => number;
  readonly #providers: SessionCredentialReaders;
  readonly #runners: RunnerIntegration;
  readonly #runtimes = new Map<string, AbortController>();
  readonly #store: SessionStore;

  constructor(
    auth: GoogleAuth,
    runners: RunnerIntegration,
    providers: SessionCredentialReaders,
    dependencies: SessionDependencies,
  ) {
    this.#auth = auth;
    this.#broker = dependencies.broker ?? new RunnerCommandBroker();
    this.#discoverModels = dependencies.discoverModels ?? discoverAgentModels;
    this.#modelFactory =
      dependencies.modelFactory ??
      ((options) => new ChatCompletionsAgentModel(options));
    this.#now = dependencies.now ?? Date.now;
    this.#providers = providers;
    this.#runners = runners;
    this.#store = new SessionStore(
      dependencies.database ?? createDatabase(":memory:"),
      dependencies.randomId ?? createUuidV7,
    );
    this.#store.failInterrupted(this.#now());
  }

  async collection(request: Request): Promise<Response> {
    return this.#forUser(request, (user) =>
      this.#collectionForUser(request, user),
    );
  }

  async directories(request: Request, runnerId: string): Promise<Response> {
    return withRequestMethod(request, "POST", () =>
      this.#forUser(request, (user) =>
        this.#directoriesForUser(request, user, runnerId),
      ),
    );
  }

  item(request: Request, sessionId: string): Response {
    return withRequestMethod(request, "GET", () =>
      this.#forUser(request, (user) =>
        this.#detailResponse(user.id, sessionId),
      ),
    );
  }

  message(request: Request, sessionId: string): Promise<Response> {
    return Promise.resolve(
      this.#postForUser(request, (user) =>
        this.#messageForUser(request, user, sessionId),
      ),
    );
  }

  models(request: Request): Promise<Response> {
    const response =
      request.method === "GET"
        ? this.#forUser(request, (user) => this.#modelsForUser(request, user))
        : createMethodNotAllowedResponse("GET");
    return Promise.resolve(response);
  }

  async stop(request: Request, sessionId: string): Promise<Response> {
    return this.#postForUser(request, (user) =>
      this.#withStoredSession(user, sessionId, (existing) => {
        if (existing.status !== "stopped") {
          this.#store.stop(user.id, sessionId, this.#now());
        }

        this.#runtimes.get(sessionId)?.abort();
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
            return this.#recordWorkResult(request, runnerId, commandId);
          default:
            return createMethodNotAllowedResponse("GET, POST");
        }
      }),
    );
  }

  async #directoriesForUser(
    request: Request,
    user: AuthenticatedUser,
    runnerId: string,
  ): Promise<Response> {
    const path = await parseJsonRequest(request, (value) => {
      const parsed = readStringField(
        value,
        "path",
        MAXIMUM_RUNNER_PATH_LENGTH,
        { trim: true },
      );
      return parsed?.includes("\0") === false ? parsed : undefined;
    });

    if (
      path === undefined ||
      readIdentifier(runnerId) === undefined ||
      !this.#runners.runnerIsAvailable(user.id, runnerId)
    ) {
      return path === undefined
        ? createApiError("invalid_request", 400)
        : createApiError("runner_unavailable", 409);
    }

    try {
      const output = await this.#broker.dispatch(
        {
          arguments: {},
          runnerId,
          sessionId: `directory-picker:${user.id}`,
          tool: RUNNER_DIRECTORY_COMMAND,
          workingDirectory: path,
        },
        AbortSignal.any([
          request.signal,
          AbortSignal.timeout(DIRECTORY_REQUEST_TIMEOUT_MILLISECONDS),
        ]),
      );
      const value: unknown = JSON.parse(output);
      return createJsonResponse(readRunnerDirectoryListing(value));
    } catch {
      return createApiError("directory_unavailable", 502);
    }
  }

  async #recordWorkResult(
    request: Request,
    runnerId: string,
    commandId: string,
  ): Promise<Response> {
    const output = await parseJsonRequest(request, readToolOutput);

    if (output === undefined) {
      return createApiError("invalid_request", 400);
    }

    return this.#broker.complete(runnerId, commandId, output)
      ? createNoContentResponse()
      : createApiError("not_found", 404);
  }

  #postForUser(
    request: Request,
    action: (user: AuthenticatedUser) => Promise<Response> | Response,
  ): Promise<Response> | Response {
    return withRequestMethod(request, "POST", () =>
      this.#forUser(request, action),
    );
  }

  #forUser<Result extends Promise<Response> | Response>(
    request: Request,
    action: (user: AuthenticatedUser) => Result,
  ): Response | Result {
    return withAuthenticatedUser(this.#auth, request, action);
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
    action: (
      credential: ProviderCredentialAccess,
    ) => Promise<Response> | Response,
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
    action: (credential: ProviderCredentialAccess) => Response,
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
        return this.#createForUser(request, user);
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
    return this.#withRuntimeAccess(user.id, input, (credential) => {
      const configuredInput = {
        ...input,
        model:
          input.model.length === 0
            ? defaultAgentModel(input.provider, credential.source)
            : input.model,
      };
      const detail = this.#store.create(
        { ...configuredInput, userId: user.id },
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
    const prompt = await parseJsonRequest(request, readPrompt);

    if (prompt === undefined) {
      return createApiError("invalid_request", 400);
    }

    return this.#withStoredSession(user, sessionId, (existing) =>
      this.#withRuntimeAccess(user.id, existing, (credential) => {
        const queued = this.#store.queuePrompt(
          user.id,
          sessionId,
          prompt,
          this.#now(),
        );

        if (queued.status === "not_found") {
          return createApiError("not_found", 404);
        }

        if (queued.status === "busy") {
          return createApiError("session_busy", 409);
        }

        this.#launch(queued.detail, credential);
        return createJsonResponse(queued.detail, 202);
      }),
    );
  }

  #launch(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
  ): void {
    queueMicrotask(() => {
      void this.#run(detail, credential);
    });
  }

  async #run(
    detail: AgentSessionDetail,
    credential: ProviderCredentialAccess,
  ): Promise<void> {
    if (!this.#store.mark(detail.id, "running", this.#now())) {
      return;
    }

    const controller = new AbortController();
    this.#runtimes.set(detail.id, controller);

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
    } finally {
      if (this.#runtimes.get(detail.id) === controller) {
        this.#runtimes.delete(detail.id);
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
