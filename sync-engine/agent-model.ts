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
import {
  AGENT_SESSION_TOOL_NAMES,
  AGENT_TOOLS,
  selectedAgentTools,
  type AgentSessionToolName,
  type AgentToolDefinition,
} from "../shared/agent-tools.ts";
import { isRecord } from "../shared/auth-model.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import { createServerWebSocket } from "../shared/server-websocket.ts";
import {
  completionMessages,
  completionSignal,
  type CompletionArguments,
  type OptionalStep,
} from "./agent-completion.ts";
import {
  usesAnthropicFormat,
  type AgentModelRequestOptions,
  type AgentProviderCredential,
} from "./agent-model-options.ts";
import type { ModelRequestSleep } from "./agent-model-retry.ts";
import {
  ANTHROPIC_CONTEXT_WINDOW_BETA,
  ANTHROPIC_VERSION,
  anthropicRequestBody,
} from "./anthropic-request.ts";
import {
  genericProviderEndpoint,
  isOfficialAnthropicEndpoint,
} from "./generic-provider-url.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import {
  providerChatMessage,
  providerResponsesInput,
} from "./provider-attachment-input.ts";
import { completeProviderHttp } from "./provider-http.ts";
import {
  promptCacheBreakpoints,
  withPromptCacheControl,
} from "./provider-prompt-cache.ts";
import type {
  ProviderModelRequest,
  ProviderRequestProtocol,
} from "./provider-request.ts";
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
  credential: AgentProviderCredential,
): boolean {
  return provider === "openai" && credential.source === "oauth";
}

function endpoint(
  provider: ProviderId,
  credential: AgentProviderCredential,
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
  credential: AgentProviderCredential,
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
  credential: AgentProviderCredential,
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
      // Sending the catalog maximum as max_tokens can exceed the context
      // window on long conversations. 4.5+ models then stop with
      // model_context_window_exceeded; this documented beta opts earlier
      // models into the same degradation instead of a validation error.
      // First-party Messages completion only: the beta changes nothing off
      // api.anthropic.com, and proxies and gateways 400 on unrecognized
      // beta names; discovery and other JSON endpoints stay reachable.
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

    // The Codex backend routes a session to the machine that already holds its
    // prompt cache, so the stable session identifier is what keeps hit rates
    // high across steps.
    if (options.promptCacheKey !== undefined) {
      headers.set("session_id", options.promptCacheKey);
    }

    setChatGptAccountHeader(headers, credential.accountId);
  }

  return headers;
}

function reasoningConfiguration(
  provider: ProviderId,
  codexOAuth: boolean,
  reasoningEffort: AgentReasoningEffort | undefined,
): Readonly<Record<string, unknown>> {
  if (codexOAuth) {
    return {
      reasoning: {
        ...(reasoningEffort === undefined ? {} : { effort: reasoningEffort }),
        summary: "auto",
      },
    };
  }

  if (reasoningEffort === undefined) {
    return {};
  }

  return provider === "openrouter"
    ? { reasoning: { effort: reasoningEffort, summary: "auto" } }
    : { reasoning_effort: reasoningEffort };
}

function toolConfiguration(
  tools: readonly AgentToolDefinition[],
  selectedTools: readonly AgentSessionToolName[],
  responsesProtocol: boolean,
  dynamicToolCache: boolean,
): Readonly<Record<string, unknown>> {
  if (tools.length === 0 || selectedTools.length === 0) {
    return {};
  }
  const toolChoice =
    dynamicToolCache && responsesProtocol
      ? {
          mode: "auto",
          tools: selectedTools.map((name) => ({ name, type: "function" })),
          type: "allowed_tools",
        }
      : "auto";
  return {
    tool_choice: toolChoice,
    tools: responsesProtocol
      ? tools.map(({ function: definition }) => ({
          ...definition,
          type: "function",
        }))
      : tools,
  };
}

function openRouterProviderPreferences(
  routing: OpenRouterProviderRouting | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (routing?.type === "provider") {
    return { allow_fallbacks: false, order: [routing.tag] };
  }
  if (routing?.type === "order") {
    return { order: [routing.tag] };
  }
  if (routing?.type === "no_fallbacks") {
    return { allow_fallbacks: false };
  }
  return routing?.type === "sort" ? { sort: routing.sort } : undefined;
}

// OpenRouter forwards Anthropic-style cache_control markers to providers that
// price cached prefixes and strips them elsewhere. Generic OpenAI-format
// endpoints get plain messages: local runtimes such as Ollama reject array
// content with tool metadata, and only the Anthropic protocol is known to
// honor the markers. OpenAI itself caches automatically, keyed by
// prompt_cache_key.
function usesCacheBreakpoints(request: ProviderModelRequest): boolean {
  return request.provider === "openrouter";
}

function chatMessages(request: ProviderModelRequest): readonly unknown[] {
  if (!usesCacheBreakpoints(request)) {
    return [
      { content: request.systemPrompt, role: "system" },
      ...request.messages.map((message) => providerChatMessage(message)),
    ];
  }
  const breakpoints = promptCacheBreakpoints(request.messages);
  return [
    {
      content: withPromptCacheControl([
        { text: request.systemPrompt, type: "text" },
      ]),
      role: "system",
    },
    ...request.messages.map((message, index) =>
      providerChatMessage(message, breakpoints.has(index)),
    ),
  ];
}

// prompt_cache_key is an OpenAI parameter; OpenRouter tolerates and may
// forward it, but strict generic OpenAI-compatible servers reject unknown
// fields, so generic requests omit it.
function promptCacheKeyField(
  request: ProviderModelRequest,
): Readonly<Record<string, string>> {
  return request.promptCacheKey === undefined || request.provider === "generic"
    ? {}
    : { prompt_cache_key: request.promptCacheKey };
}

function requestBody(request: ProviderModelRequest): unknown {
  if (request.protocol === "anthropic") {
    return anthropicRequestBody(request);
  }

  const responsesProtocol = request.protocol === "responses";
  const reasoning = reasoningConfiguration(
    request.provider,
    responsesProtocol,
    request.reasoningEffort,
  );
  const tools = toolConfiguration(
    request.tools,
    request.selectedTools,
    responsesProtocol,
    request.dynamicToolCache,
  );

  if (!responsesProtocol) {
    return {
      messages: chatMessages(request),
      model: request.model,
      ...(request.provider === "openrouter" &&
      request.openRouterProviderRouting !== undefined
        ? {
            provider: openRouterProviderPreferences(
              request.openRouterProviderRouting,
            ),
          }
        : {}),
      ...promptCacheKeyField(request),
      ...reasoning,
      ...(request.stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
      ...tools,
    };
  }

  return {
    include: ["reasoning.encrypted_content"],
    input: request.messages.flatMap(providerResponsesInput),
    instructions: request.systemPrompt,
    model: request.model,
    parallel_tool_calls: false,
    ...promptCacheKeyField(request),
    ...reasoning,
    store: false,
    ...(request.stream ? { stream: true } : {}),
    ...tools,
  };
}

interface CompletionInput {
  readonly messages: readonly AgentConversationMessage[];
  readonly signal: AbortSignal | undefined;
}

function completionInput(parameters: CompletionArguments): CompletionInput {
  return {
    messages: completionMessages(parameters),
    signal: completionSignal(parameters),
  };
}

function headersRecord(headers: Headers): Readonly<Record<string, string>> {
  return Object.fromEntries(headers.entries());
}

function defaultWebSocket(
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) {
  return createServerWebSocket(url, options.headers);
}

export class ChatCompletionsAgentModel implements AgentModel {
  readonly #credential: AgentProviderCredential;
  readonly #dynamicToolCache: boolean;
  readonly #fetch: AgentModelFetch;
  readonly #maxOutputTokens: number | null;
  readonly #model: string;
  readonly #onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly #onStepStart: () => void;
  readonly #openRouterProviderRouting: OpenRouterProviderRouting | undefined;
  readonly #promptCacheKey: string | undefined;
  readonly #provider: ProviderId;
  readonly #reasoningEffort: AgentReasoningEffort | undefined;
  readonly #sleep: ModelRequestSleep | undefined;
  readonly #systemPrompt: string;
  readonly #selectedTools: readonly AgentSessionToolName[];
  readonly #tools: readonly AgentToolDefinition[];
  readonly #webSocket: ProviderWebSocketFactory;
  readonly #webSocketSession = new ProviderWebSocketSession();

  constructor(options: ChatCompletionsAgentModelOptions) {
    this.#credential = options.credential;
    this.#dynamicToolCache = options.dynamicToolCache === true;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#maxOutputTokens = options.maxOutputTokens ?? null;
    this.#model = options.model;
    this.#onDelta = options.onDelta;
    this.#onStepStart = options.onStepStart ?? (() => undefined);
    this.#openRouterProviderRouting =
      options.openRouterProviderRouting ??
      (options.openRouterProviderTag === undefined
        ? undefined
        : { tag: options.openRouterProviderTag, type: "provider" });
    this.#promptCacheKey = options.promptCacheKey;
    this.#provider = options.provider;
    this.#reasoningEffort = options.reasoningEffort ?? undefined;
    this.#sleep = options.sleep;
    this.#systemPrompt = options.systemPrompt ?? AGENT_SYSTEM_PROMPT;
    this.#selectedTools = options.tools ?? AGENT_SESSION_TOOL_NAMES;
    this.#tools = this.#dynamicToolCache
      ? AGENT_TOOLS
      : selectedAgentTools(this.#selectedTools);
    this.#webSocket = options.webSocket ?? defaultWebSocket;
  }

  readonly startStep = (): void => {
    this.#onStepStart();
  };

  readonly close = (): void => {
    this.#webSocketSession.close();
  };

  async complete(...parameters: CompletionArguments): Promise<AgentModelStep> {
    if (this.#provider !== "openai") {
      return this.#completeHttp(...parameters);
    }

    const webSocketTurn = await this.#tryWebSocket(...parameters);
    if (webSocketTurn !== undefined) {
      return webSocketTurn;
    }
    if (parameters[1]?.aborted === true) {
      throw new DOMException("The model request was aborted", "AbortError");
    }
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
      this.#onDelta?.({ content: "", reset: true, thinking: "" });
    }
  }

  async #tryWebSocket(
    ...parameters: CompletionArguments
  ): Promise<OptionalStep> {
    const signal = completionSignal(parameters);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#completeWebSocket(...parameters);
      } catch (error) {
        this.#acceptWebSocketInterruption(error, signal);
        const delay = PROVIDER_WEBSOCKET_RETRY_DELAYS_MILLISECONDS[attempt];
        if (delay === undefined) {
          return undefined;
        }
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
  ): unknown {
    return requestBody({
      dynamicToolCache: this.#dynamicToolCache,
      maxOutputTokens: this.#maxOutputTokens,
      messages,
      model: this.#model,
      openRouterProviderRouting: this.#openRouterProviderRouting,
      promptCacheKey: this.#promptCacheKey,
      protocol,
      provider: this.#provider,
      reasoningEffort: this.#reasoningEffort,
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
    signal?: AbortSignal;
  } {
    return {
      ...(this.#onDelta === undefined ? {} : { onDelta: this.#onDelta }),
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

  #completeHttp(...parameters: CompletionArguments): Promise<AgentModelStep> {
    const input = completionInput(parameters);
    const protocol = this.#httpProtocol();
    return completeProviderHttp(
      {
        body: this.#requestBody(input.messages, protocol, true),
        fetch: this.#fetch,
        headers: agentProviderRequestHeaders(this.#provider, this.#credential, {
          accept: "text/event-stream",
          ...promptCacheKeyHeader(this.#promptCacheKey),
          protocol,
        }),
        onDelta: this.#onDelta,
        protocol,
        provider: this.#provider,
        sleep: this.#sleep,
        url: endpoint(this.#provider, this.#credential),
      },
      input.signal,
    );
  }
}
