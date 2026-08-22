import { setTimeout } from "node:timers/promises";
import type {
  AgentReasoningEffort,
  OpenRouterProviderRouting,
} from "../shared/agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../shared/agent-loop.ts";
import { AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt.ts";
import { selectedAgentTools } from "../shared/agent-tool-selection.ts";
import {
  AGENT_SESSION_TOOL_NAMES,
  type AgentSessionToolName,
  type AgentToolDefinition,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { DEFAULT_TOOL_SETTINGS } from "../shared/tool-limits.ts";
import {
  completionMessages,
  completionSignal,
  type CompletionArguments,
  type OptionalStep,
} from "./agent-completion.ts";
import {
  agentCredentialFingerprint,
  usesAnthropicFormat,
  type AgentCredentialRefresher,
  type AgentModelRequestOptions,
  type AgentProviderCredential,
} from "./agent-model-options.ts";
import type { ModelRequestSleep } from "./agent-model-retry.ts";
import {
  defaultAgentModelWebSocket,
  emptyOutputDelta,
  headersRecord,
} from "./agent-model-transport.ts";
import { completeAnthropicPauseTurns } from "./anthropic-continuation.ts";
import { resolveAnthropicModelAttempt } from "./anthropic-model-resolution.ts";
import { anthropicReplayIdentityFrom } from "./anthropic-replay-identity.ts";
import { validateAnthropicStepContinuation } from "./anthropic-step-continuation.ts";
import {
  ANTHROPIC_CONTEXT_WINDOW_BETA,
  ANTHROPIC_VERSION,
  assertAnthropicContinuationReplays,
} from "./anthropic-request.ts";
import {
  genericProviderEndpoint,
  isOfficialAnthropicEndpoint,
} from "./generic-provider-url.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import { recoverOpenAiOAuthUnauthorized } from "./openai-unauthorized-recovery.ts";
import { completeProviderHttp } from "./provider-http.ts";
import { requestBody } from "./provider-request-body.ts";
import type { ProviderRequestProtocol } from "./provider-request.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";
import {
  ProviderWebSocketError,
  ProviderWebSocketSession,
  type ProviderWebSocketFactory,
} from "./provider-websocket.ts";

export type { AgentProviderCredential } from "./agent-model-options.ts";

const OPENAI_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_WEBSOCKET_URL = "wss://api.openai.com/v1/responses";
const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_CODEX_RESPONSES_WEBSOCKET_URL =
  "wss://chatgpt.com/backend-api/codex/responses";
const PROVIDER_WEBSOCKET_RETRY_DELAYS_MILLISECONDS = [
  1_000, 2_000, 4_000,
] as const;
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export type AgentModelFetch = (request: Request) => Promise<Response>;

export interface ChatCompletionsAgentModelOptions extends AgentModelRequestOptions {
  readonly fetch?: AgentModelFetch;
  readonly sleep?: ModelRequestSleep;
  readonly webSocket?: ProviderWebSocketFactory;
}

function usesCodexOAuth(
  provider: ProviderId,
  credential: Pick<AgentProviderCredential, "source">,
): boolean {
  return provider === "openai" && credential.source === "oauth";
}

function endpoint(
  provider: ProviderId,
  credential: Pick<AgentProviderCredential, "apiFormat" | "baseUrl" | "source">,
): string {
  if (usesCodexOAuth(provider, credential)) {
    return OPENAI_CODEX_RESPONSES_URL;
  }

  switch (provider) {
    case "openai":
      return OPENAI_COMPLETIONS_URL;
    case "openrouter":
      return OPENROUTER_COMPLETIONS_URL;
    case "generic":
      return genericProviderEndpoint(
        credential.baseUrl,
        usesAnthropicFormat(provider, credential)
          ? "messages"
          : "chat/completions",
      );
  }
}

function accessToken(
  provider: ProviderId,
  credential: Pick<AgentProviderCredential, "secret" | "source">,
): string {
  return provider === "openai" && credential.source === "oauth"
    ? readOpenAiOAuthCredential(credential.secret).access
    : credential.secret;
}

export function setChatGptAccountHeader(
  headers: Headers,
  accountId: string | null,
): void {
  if (accountId !== null) {
    headers.set("chatgpt-account-id", accountId);
  }
}

export interface AgentProviderRequestHeaderOptions {
  readonly accept: string;
  readonly promptCacheKey?: string;
  readonly protocol?: ProviderRequestProtocol;
}

function promptCacheKeyHeader(
  promptCacheKey: string | undefined,
): Readonly<Pick<AgentProviderRequestHeaderOptions, "promptCacheKey">> {
  return promptCacheKey === undefined ? {} : { promptCacheKey };
}

export function agentProviderRequestHeaders(
  provider: ProviderId,
  credential: Pick<
    AgentProviderCredential,
    "accountId" | "apiFormat" | "baseUrl" | "secret" | "source"
  >,
  options: AgentProviderRequestHeaderOptions,
): Headers {
  const headers = new Headers({
    accept: options.accept,
    "content-type": "application/json",
  });
  const token = accessToken(provider, credential);

  if (usesAnthropicFormat(provider, credential)) {
    headers.set("anthropic-version", ANTHROPIC_VERSION);
    if (
      options.protocol === "anthropic" &&
      isOfficialAnthropicEndpoint(credential.baseUrl)
    ) {
      // The beta degrades pre-4.5 context overshoots to a stop, not an error.
      // First-party only: gateways reject unknown betas.
      headers.set("anthropic-beta", ANTHROPIC_CONTEXT_WINDOW_BETA);
    }
    if (token.length > 0) {
      headers.set("x-api-key", token);
    }
    return headers;
  }

  if (token.length > 0) {
    headers.set("authorization", `Bearer ${token}`);
  }

  if (provider === "openrouter") {
    headers.set("http-referer", "https://q-mush.local");
    headers.set("x-title", "Q Mush");
  } else if (usesCodexOAuth(provider, credential)) {
    if (
      options.accept === "text/event-stream" ||
      options.accept === "application/websocket-events"
    ) {
      headers.set(
        "openai-beta",
        options.accept === "application/websocket-events"
          ? "responses_websockets=2026-02-06"
          : "responses=experimental",
      );
    }

    headers.set("originator", "q_mush");

    if (options.promptCacheKey !== undefined) {
      headers.set("session_id", options.promptCacheKey);
    }

    setChatGptAccountHeader(headers, credential.accountId);
  }

  return headers;
}

interface CompletionInput {
  readonly messages: readonly AgentConversationMessage[];
  readonly signal: AbortSignal | undefined;
}

function completionInput(
  parameters: CompletionArguments,
  model?: string,
): CompletionInput {
  return {
    messages: completionMessages(parameters, model),
    signal: completionSignal(parameters),
  };
}

export class ChatCompletionsAgentModel implements AgentModel {
  readonly #adaptiveThinking: boolean | null;
  #credential: AgentProviderCredential;
  readonly #credentialFingerprint: string;
  readonly #dynamicToolCache: boolean;
  readonly #fetch: AgentModelFetch;
  readonly #maxOutputTokens: number | null;
  readonly #model: string;
  readonly #onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly #onRequestState: AgentModelRequestOptions["onRequestState"];
  readonly #onStepStart: () => void;
  readonly #openRouterProviderRouting: OpenRouterProviderRouting | undefined;
  readonly #promptCacheKey: string | undefined;
  readonly #provider: ProviderId;
  readonly #reasoningEffort: AgentReasoningEffort | undefined;
  readonly #refreshCredential: AgentCredentialRefresher | undefined;
  readonly #resolvedModel: string | null | undefined;
  #resolvedModelPromise: Promise<string | undefined> | undefined;
  readonly #sleep: ModelRequestSleep | undefined;
  readonly #systemPrompt: string;
  readonly #selectedTools: readonly AgentSessionToolName[];
  readonly #tools: readonly AgentToolDefinition[];
  readonly #webSocket: ProviderWebSocketFactory;
  readonly #webSocketSession = new ProviderWebSocketSession();

  constructor(options: ChatCompletionsAgentModelOptions) {
    this.#adaptiveThinking = options.adaptiveThinking ?? null;
    this.#credential = options.credential;
    this.#credentialFingerprint =
      options.credentialFingerprint ??
      agentCredentialFingerprint(options.credential);
    this.#dynamicToolCache = options.dynamicToolCache === true;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#maxOutputTokens = options.maxOutputTokens ?? null;
    this.#model = options.model;
    this.#onDelta = options.onDelta;
    this.#onRequestState = options.onRequestState;
    this.#onStepStart = options.onStepStart ?? (() => undefined);
    this.#openRouterProviderRouting =
      options.openRouterProviderRouting ??
      (options.openRouterProviderTag === undefined
        ? undefined
        : { tag: options.openRouterProviderTag, type: "provider" });
    this.#promptCacheKey = options.promptCacheKey;
    this.#provider = options.provider;
    this.#reasoningEffort = options.reasoningEffort ?? undefined;
    this.#refreshCredential = options.refreshCredential;
    this.#resolvedModel = options.resolvedModel;
    this.#sleep = options.sleep;
    this.#systemPrompt = options.systemPrompt ?? AGENT_SYSTEM_PROMPT;
    this.#selectedTools = options.tools ?? AGENT_SESSION_TOOL_NAMES;
    this.#tools = selectedAgentTools(
      this.#dynamicToolCache ? AGENT_SESSION_TOOL_NAMES : this.#selectedTools,
      options.toolSettings ?? DEFAULT_TOOL_SETTINGS,
    );
    this.#webSocket = options.webSocket ?? defaultAgentModelWebSocket;
  }

  readonly startStep = (): void => {
    this.#onStepStart();
  };

  readonly close = (): void => {
    this.#webSocketSession.close();
  };

  #resetOutput(): void {
    this.#onDelta?.({ content: "", reset: true, thinking: "" });
  }

  async complete(...parameters: CompletionArguments): Promise<AgentModelStep> {
    try {
      return await this.#completeWithCurrentCredential(...parameters);
    } catch (error) {
      return recoverOpenAiOAuthUnauthorized({
        complete: () => this.#completeWithCurrentCredential(...parameters),
        currentCredential: this.#credential,
        error,
        provider: this.#provider,
        refreshCredential: this.#refreshCredential,
        replaceCredential: (credential) => {
          this.#credential = credential;
        },
        resetOutput: () => {
          this.#resetOutput();
        },
        resetTransport: () => {
          this.#webSocketSession.close();
        },
      });
    }
  }

  async #completeWithCurrentCredential(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    if (this.#provider !== "openai") {
      this.#onRequestState?.("active");
      return this.#completeHttp(...parameters);
    }

    const webSocketTurn = await this.#tryWebSocket(...parameters);
    if (webSocketTurn !== undefined) {
      return webSocketTurn;
    }
    if (parameters[1]?.aborted === true) {
      throw new DOMException("The model request was aborted", "AbortError");
    }
    this.#onRequestState?.("active");
    return this.#completeHttp(...parameters);
  }

  #acceptWebSocketInterruption(
    error: unknown,
    signal: AbortSignal | undefined,
  ): void {
    if (
      signal?.aborted === true ||
      !(error instanceof ProviderWebSocketError)
    ) {
      throw error;
    }
    if (error.started) {
      this.#resetOutput();
    }
  }

  async #tryWebSocket(
    ...parameters: CompletionArguments
  ): Promise<OptionalStep> {
    const signal = completionSignal(parameters);

    let reconnectImmediately = true;
    let transientAttempt = 0;
    for (;;) {
      try {
        return await this.#completeWebSocket(...parameters);
      } catch (error) {
        this.#acceptWebSocketInterruption(error, signal);
        const immediate =
          error instanceof ProviderWebSocketError && error.reconnectImmediately;
        if (immediate && reconnectImmediately) {
          // The documented expiry requires a fresh socket. Grant one immediate
          // replacement per model step, independent of ordinary retry capacity;
          // repeated limit events then use bounded transient backoff.
          reconnectImmediately = false;
          continue;
        }
        const delay =
          PROVIDER_WEBSOCKET_RETRY_DELAYS_MILLISECONDS[transientAttempt];
        if (delay === undefined) {
          return undefined;
        }
        transientAttempt += 1;
        await this.#waitForRetry(
          error instanceof ProviderWebSocketError &&
            error.retryAfterMilliseconds !== undefined
            ? error.retryAfterMilliseconds
            : delay,
          signal,
        );
      }
    }
  }

  #waitForRetry(
    milliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return this.#sleep === undefined
      ? setTimeout(milliseconds, undefined, { signal })
      : this.#sleep(milliseconds, signal);
  }

  #requestBody(
    messages: readonly AgentConversationMessage[],
    protocol: ProviderRequestProtocol,
    stream: boolean,
    resolvedModel?: string,
  ): unknown {
    return requestBody({
      adaptiveThinking: this.#adaptiveThinking,
      credential: this.#credential,
      credentialFingerprint: this.#credentialFingerprint,
      dynamicToolCache: this.#dynamicToolCache,
      maxOutputTokens: this.#maxOutputTokens,
      messages,
      model: this.#model,
      openRouterProviderRouting: this.#openRouterProviderRouting,
      promptCacheKey: this.#promptCacheKey,
      protocol,
      provider: this.#provider,
      reasoningEffort: this.#reasoningEffort,
      resolvedModel,
      selectedTools: this.#selectedTools,
      stream,
      systemPrompt: this.#systemPrompt,
      tools: this.#tools,
    });
  }

  #httpProtocol(): ProviderRequestProtocol {
    if (usesCodexOAuth(this.#provider, this.#credential)) {
      return "responses";
    }
    return usesAnthropicFormat(this.#provider, this.#credential)
      ? "anthropic"
      : "chat_completions";
  }

  #webSocketOptions(signal: AbortSignal | undefined): {
    onDelta?: (delta: ProviderTextDelta) => void;
    onRequestState: NonNullable<AgentModelRequestOptions["onRequestState"]>;
    signal?: AbortSignal;
  } {
    return {
      ...(this.#onDelta === undefined ? {} : { onDelta: this.#onDelta }),
      onRequestState: this.#onRequestState ?? (() => undefined),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  #completeWebSocket(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    const { messages, signal } = completionInput(parameters);
    const headers = agentProviderRequestHeaders(
      this.#provider,
      this.#credential,
      {
        accept: "application/websocket-events",
        ...promptCacheKeyHeader(this.#promptCacheKey),
      },
    );
    const codexOAuth = usesCodexOAuth(this.#provider, this.#credential);
    const body = this.#requestBody(messages, "responses", false);

    if (!isRecord(body)) {
      throw new Error("The model request body was invalid");
    }

    return this.#webSocketSession.complete({
      body,
      createSocket: this.#webSocket,
      headers: headersRecord(headers),
      ...this.#webSocketOptions(signal),
      url: codexOAuth
        ? OPENAI_CODEX_RESPONSES_WEBSOCKET_URL
        : OPENAI_RESPONSES_WEBSOCKET_URL,
    });
  }

  #anthropicResolvedModel(
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (this.#resolvedModel !== undefined) {
      return Promise.resolve(this.#resolvedModel ?? undefined);
    }
    if (this.#resolvedModelPromise !== undefined) {
      return this.#resolvedModelPromise;
    }
    const resolution = resolveAnthropicModelAttempt({
      credential: this.#credential,
      fetch: this.#fetch,
      model: this.#model,
      provider: this.#provider,
      ...(signal === undefined ? {} : { signal }),
    });
    this.#resolvedModelPromise = resolution.then((result) => {
      if (result.retryable) {
        this.#resolvedModelPromise = undefined;
      }
      return result.model;
    });
    return this.#resolvedModelPromise;
  }

  #anthropicReplayIdentity(
    resolvedModel: string | undefined,
  ): ReturnType<typeof anthropicReplayIdentityFrom> {
    const options = {
      credential: this.#credential,
      credentialFingerprint: this.#credentialFingerprint,
      model: this.#model,
      provider: this.#provider,
    };
    return resolvedModel === undefined
      ? anthropicReplayIdentityFrom(options)
      : anthropicReplayIdentityFrom({ ...options, resolvedModel });
  }

  #assertAnthropicContinuationReplays(
    messages: readonly AgentConversationMessage[],
    resolvedModel: string | undefined,
  ): void {
    assertAnthropicContinuationReplays(
      messages,
      this.#anthropicReplayIdentity(resolvedModel),
    );
  }

  async #httpRequest(
    messages: readonly AgentConversationMessage[],
    protocol: ProviderRequestProtocol,
    signal: AbortSignal | undefined,
    resolvedModel: string | undefined,
    onStreamRetry?: () => void,
  ): Promise<AgentModelStep> {
    if (protocol === "anthropic") {
      this.#assertAnthropicContinuationReplays(messages, resolvedModel);
    }
    const step = await completeProviderHttp(
      {
        body: this.#requestBody(messages, protocol, true, resolvedModel),
        credential: this.#credential,
        credentialFingerprint: this.#credentialFingerprint,
        fetch: this.#fetch,
        headers: agentProviderRequestHeaders(this.#provider, this.#credential, {
          accept: "text/event-stream",
          ...promptCacheKeyHeader(this.#promptCacheKey),
          protocol,
        }),
        model: this.#model,
        onDelta: this.#onDelta,
        ...(onStreamRetry === undefined ? {} : { onStreamRetry }),
        protocol,
        provider: this.#provider,
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
        sleep: this.#sleep,
        url: endpoint(this.#provider, this.#credential),
      },
      signal,
    );
    if (protocol !== "anthropic") return step;
    const continuationModel =
      resolvedModel === undefined &&
      (step.toolCalls.length > 0 ||
        step.providerContinuation === "anthropic_pause_turn")
        ? await this.#anthropicResolvedModel(signal)
        : resolvedModel;
    return validateAnthropicStepContinuation(
      step,
      this.#anthropicReplayIdentity(continuationModel),
    );
  }

  async #completeHttp(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    const protocol = this.#httpProtocol();
    const input = completionInput(parameters, this.#model);
    const resolvedModel =
      protocol === "anthropic"
        ? await this.#anthropicResolvedModel(input.signal)
        : undefined;
    if (protocol === "anthropic") {
      this.#assertAnthropicContinuationReplays(parameters[0], resolvedModel);
    }
    const step = await this.#httpRequest(
      input.messages,
      protocol,
      input.signal,
      resolvedModel,
    );
    if (
      step.providerContinuation === "anthropic_replay_unavailable" &&
      step.toolCalls.length > 0
    ) {
      return step;
    }
    return protocol === "anthropic"
      ? completeAnthropicPauseTurns(
          input.messages,
          step,
          async (messages, output) => {
            const restoreOutput = (): void => {
              this.#onDelta?.(output);
            };
            this.#onDelta?.(emptyOutputDelta());
            restoreOutput();
            return this.#httpRequest(
              messages,
              protocol,
              input.signal,
              resolvedModel,
              restoreOutput,
            );
          },
        )
      : step;
  }
}
