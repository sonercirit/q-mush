import { runAgentLoop, type AgentModel } from "./agent-loop.ts";
import {
  ChatCompletionsAgentModel,
  type AgentProviderCredential,
} from "./agent-model.ts";
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
import type { RunnerIntegration } from "./runners.ts";
import type { AgentSessionDetail } from "./session-model.ts";
import { SessionStore, type CreateAgentSession } from "./session-store.ts";

const MAXIMUM_PROMPT_LENGTH = 32_768;
const MAXIMUM_PATH_LENGTH = 4_096;
const MAXIMUM_RESULT_LENGTH = 512 * 1_024;
const IDENTIFIER_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;
const MODEL_PATTERN = /^[A-Za-z\d][A-Za-z\d._:/-]{0,199}$/u;

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
}

type AgentModelFactory = (options: AgentModelFactoryOptions) => AgentModel;

interface SessionDependencies {
  readonly broker?: RunnerCommandBroker;
  readonly database?: AppDatabase;
  readonly modelFactory?: AgentModelFactory;
  readonly now?: () => number;
  readonly randomId?: IdGenerator;
}

type CreateSessionInput = Omit<CreateAgentSession, "userId">;

interface RuntimeSelection {
  readonly credentialId: string;
  readonly provider: ProviderId;
  readonly runnerId: string;
}

export interface SessionIntegration {
  collection(request: Request): Promise<Response>;
  item(request: Request, sessionId: string): Response;
  message(request: Request, sessionId: string): Promise<Response>;
  stop(request: Request, sessionId: string): Promise<Response>;
  work(request: Request): Response;
  workResult(request: Request, commandId: string): Promise<Response>;
}

function defaultModel(
  provider: ProviderId,
  source: ProviderCredentialAccess["source"],
): string {
  if (provider === "openrouter") {
    return "openai/gpt-4.1-mini";
  }

  return source === "oauth" ? "gpt-5-codex" : "gpt-4.1-mini";
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
    MAXIMUM_PATH_LENGTH,
    { trim: true },
  );
  const modelValue = value["model"];

  if (
    credentialId === undefined ||
    provider === undefined ||
    runnerId === undefined ||
    prompt === undefined ||
    workingDirectory === undefined ||
    workingDirectory.includes("\0") ||
    (modelValue !== undefined &&
      (typeof modelValue !== "string" || !MODEL_PATTERN.test(modelValue)))
  ) {
    return undefined;
  }

  return {
    credentialId,
    model: typeof modelValue === "string" ? modelValue : "",
    prompt,
    provider,
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

  async #withRuntimeAccess(
    userId: string,
    selection: RuntimeSelection,
    action: (credential: ProviderCredentialAccess) => Response,
  ): Promise<Response> {
    if (!this.#runners.runnerIsAvailable(userId, selection.runnerId)) {
      return createApiError("runner_unavailable", 409);
    }

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
            ? defaultModel(input.provider, credential.source)
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
      const model = this.#modelFactory({
        credential,
        model: detail.model,
        provider: detail.provider,
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
          if (message.role !== "user") {
            this.#store.appendAgentMessage(detail.id, message, this.#now());
          }
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
