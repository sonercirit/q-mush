import { setTimeout } from "node:timers/promises";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../shared/agent-loop.ts";
import { AGENT_SYSTEM_PROMPT } from "../shared/agent-prompt.ts";
import { selectedAgentTools } from "../shared/agent-tool-selection.ts";
import { AGENT_SESSION_TOOL_NAMES } from "../shared/agent-tools.ts";
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
import {
  ANTHROPIC_CONTEXT_WINDOW_BETA,
  ANTHROPIC_VERSION,
  assertAnthropicContinuationReplays,
} from "./anthropic-request.ts";
import { validateAnthropicStepContinuation } from "./anthropic-step-continuation.ts";
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
  createProviderWebSocketSession,
  isProviderWebSocketError,
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

  const providerEndpoints: Record<ProviderId, () => string> = {
    generic: () =>
      genericProviderEndpoint(
        credential.baseUrl,
        usesAnthropicFormat(provider, credential)
          ? "messages"
          : "chat/completions",
      ),
    openai: () => OPENAI_COMPLETIONS_URL,
    openrouter: () => OPENROUTER_COMPLETIONS_URL,
  };
  return providerEndpoints[provider]();
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

export interface ChatCompletionsAgentModel extends AgentModel {
  readonly close: () => void;
  readonly startStep: () => void;
}

export function createChatCompletionsAgentModel(
  options: ChatCompletionsAgentModelOptions,
): ChatCompletionsAgentModel {
  const adaptiveThinking = options.adaptiveThinking ?? null;
  let credential = options.credential;
  const credentialFingerprint =
    options.credentialFingerprint ??
    agentCredentialFingerprint(options.credential);
  const dynamicToolCache = options.dynamicToolCache === true;
  const maxOutputTokens = options.maxOutputTokens ?? null;
  const fetch = options.fetch ?? globalThis.fetch;
  const model = options.model;
  const onDelta = options.onDelta;
  const onRequestState = options.onRequestState;
  const onStepStart = options.onStepStart ?? (() => undefined);
  const openRouterProviderRouting =
    options.openRouterProviderRouting ??
    (options.openRouterProviderTag === undefined
      ? undefined
      : { tag: options.openRouterProviderTag, type: "provider" });
  const promptCacheKey = options.promptCacheKey;
  const provider = options.provider;
  const reasoningEffort = options.reasoningEffort ?? undefined;
  const refreshCredential = options.refreshCredential;
  const resolvedModel = options.resolvedModel;
  const sleep = options.sleep;
  const systemPrompt = options.systemPrompt ?? AGENT_SYSTEM_PROMPT;
  const selectedTools = options.tools ?? AGENT_SESSION_TOOL_NAMES;
  const tools = selectedAgentTools(
    dynamicToolCache ? AGENT_SESSION_TOOL_NAMES : selectedTools,
    options.toolSettings ?? DEFAULT_TOOL_SETTINGS,
  );
  const webSocket = options.webSocket ?? defaultAgentModelWebSocket;
  const webSocketSession = createProviderWebSocketSession();
  let resolvedModelPromise: Promise<string | undefined> | undefined;

  const startStep = (): void => {
    onStepStart();
  };

  const close = (): void => {
    webSocketSession.close();
  };

  function resetOutput(): void {
    onDelta?.({ content: "", reset: true, thinking: "" });
  }

  async function complete(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    try {
      return await completeWithCurrentCredential(...parameters);
    } catch (error) {
      return recoverOpenAiOAuthUnauthorized({
        complete: () => completeWithCurrentCredential(...parameters),
        currentCredential: credential,
        error,
        provider: provider,
        refreshCredential: refreshCredential,
        replaceCredential: (replacement) => {
          credential = replacement;
        },
        resetOutput: () => {
          resetOutput();
        },
        resetTransport: () => {
          webSocketSession.close();
        },
      });
    }
  }

  async function completeWithCurrentCredential(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    if (provider !== "openai") {
      onRequestState?.("active");
      return completeHttp(...parameters);
    }

    const webSocketTurn = await tryWebSocket(...parameters);
    if (webSocketTurn !== undefined) {
      return webSocketTurn;
    }
    if (parameters[1]?.aborted === true) {
      throw new DOMException("The model request was aborted", "AbortError");
    }
    onRequestState?.("active");
    return completeHttp(...parameters);
  }

  function acceptWebSocketInterruption(
    error: unknown,
    signal: AbortSignal | undefined,
  ): void {
    if (signal?.aborted === true || !isProviderWebSocketError(error)) {
      throw error;
    }
    if (error.started) {
      resetOutput();
    }
  }

  async function tryWebSocket(
    ...parameters: CompletionArguments
  ): Promise<OptionalStep> {
    const signal = completionSignal(parameters);

    let reconnectImmediately = true;
    let transientAttempt = 0;
    for (;;) {
      try {
        return await completeWebSocket(...parameters);
      } catch (error) {
        acceptWebSocketInterruption(error, signal);
        const immediate =
          isProviderWebSocketError(error) && error.reconnectImmediately;
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
        await waitForRetry(
          isProviderWebSocketError(error) &&
            error.retryAfterMilliseconds !== undefined
            ? error.retryAfterMilliseconds
            : delay,
          signal,
        );
      }
    }
  }

  function waitForRetry(
    milliseconds: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return sleep === undefined
      ? setTimeout(milliseconds, undefined, { signal })
      : sleep(milliseconds, signal);
  }

  function createModelRequestBody(
    messages: readonly AgentConversationMessage[],
    protocol: ProviderRequestProtocol,
    stream: boolean,
    resolvedModel?: string,
  ): unknown {
    return requestBody({
      adaptiveThinking: adaptiveThinking,
      credential: credential,
      credentialFingerprint: credentialFingerprint,
      dynamicToolCache: dynamicToolCache,
      maxOutputTokens: maxOutputTokens,
      messages,
      model: model,
      openRouterProviderRouting: openRouterProviderRouting,
      promptCacheKey: promptCacheKey,
      protocol,
      provider: provider,
      reasoningEffort: reasoningEffort,
      resolvedModel,
      selectedTools: selectedTools,
      stream,
      systemPrompt: systemPrompt,
      tools: tools,
    });
  }

  function httpProtocol(): ProviderRequestProtocol {
    if (usesCodexOAuth(provider, credential)) {
      return "responses";
    }
    return usesAnthropicFormat(provider, credential)
      ? "anthropic"
      : "chat_completions";
  }

  function webSocketOptions(signal: AbortSignal | undefined): {
    onDelta?: (delta: ProviderTextDelta) => void;
    onRequestState: NonNullable<AgentModelRequestOptions["onRequestState"]>;
    signal?: AbortSignal;
  } {
    return {
      ...(onDelta === undefined ? {} : { onDelta: onDelta }),
      onRequestState: onRequestState ?? (() => undefined),
      ...(signal === undefined ? {} : { signal }),
    };
  }

  function completeWebSocket(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    const { messages, signal } = completionInput(parameters);
    const headers = agentProviderRequestHeaders(provider, credential, {
      accept: "application/websocket-events",
      ...promptCacheKeyHeader(promptCacheKey),
    });
    const codexOAuth = usesCodexOAuth(provider, credential);
    const body = createModelRequestBody(messages, "responses", false);

    if (!isRecord(body)) {
      throw new Error("The model request body was invalid");
    }

    return webSocketSession.complete({
      body,
      createSocket: webSocket,
      headers: headersRecord(headers),
      ...webSocketOptions(signal),
      url: codexOAuth
        ? OPENAI_CODEX_RESPONSES_WEBSOCKET_URL
        : OPENAI_RESPONSES_WEBSOCKET_URL,
    });
  }

  function anthropicResolvedModel(
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    if (resolvedModel !== undefined) {
      return Promise.resolve(resolvedModel ?? undefined);
    }
    if (resolvedModelPromise !== undefined) {
      return resolvedModelPromise;
    }
    const resolution = resolveAnthropicModelAttempt({
      credential: credential,
      fetch: fetch,
      model: model,
      provider: provider,
      ...(signal === undefined ? {} : { signal }),
    });
    resolvedModelPromise = resolution.then((result) => {
      if (result.retryable) {
        resolvedModelPromise = undefined;
      }
      return result.model;
    });
    return resolvedModelPromise;
  }

  function anthropicReplayIdentity(
    resolvedModel: string | undefined,
  ): ReturnType<typeof anthropicReplayIdentityFrom> {
    const options = {
      credential: credential,
      credentialFingerprint: credentialFingerprint,
      model: model,
      provider: provider,
    };
    return resolvedModel === undefined
      ? anthropicReplayIdentityFrom(options)
      : anthropicReplayIdentityFrom({ ...options, resolvedModel });
  }

  function validateAnthropicContinuationReplays(
    messages: readonly AgentConversationMessage[],
    resolvedModel: string | undefined,
  ): void {
    assertAnthropicContinuationReplays(
      messages,
      anthropicReplayIdentity(resolvedModel),
    );
  }

  async function httpRequest(
    messages: readonly AgentConversationMessage[],
    protocol: ProviderRequestProtocol,
    signal: AbortSignal | undefined,
    resolvedModel: string | undefined,
    onStreamRetry?: () => void,
  ): Promise<AgentModelStep> {
    if (protocol === "anthropic") {
      validateAnthropicContinuationReplays(messages, resolvedModel);
    }
    const step = await completeProviderHttp(
      {
        body: createModelRequestBody(messages, protocol, true, resolvedModel),
        credential: credential,
        credentialFingerprint: credentialFingerprint,
        fetch: fetch,
        headers: agentProviderRequestHeaders(provider, credential, {
          accept: "text/event-stream",
          ...promptCacheKeyHeader(promptCacheKey),
          protocol,
        }),
        model: model,
        onDelta: onDelta,
        ...(onStreamRetry === undefined ? {} : { onStreamRetry }),
        protocol,
        provider: provider,
        ...(resolvedModel === undefined ? {} : { resolvedModel }),
        sleep: sleep,
        url: endpoint(provider, credential),
      },
      signal,
    );
    if (protocol !== "anthropic") return step;
    const continuationModel =
      resolvedModel === undefined &&
      (step.toolCalls.length > 0 ||
        step.providerContinuation === "anthropic_pause_turn")
        ? await anthropicResolvedModel(signal)
        : resolvedModel;
    return validateAnthropicStepContinuation(
      step,
      anthropicReplayIdentity(continuationModel),
    );
  }

  async function completeHttp(
    ...parameters: CompletionArguments
  ): Promise<AgentModelStep> {
    const protocol = httpProtocol();
    const input = completionInput(parameters, model);
    const resolvedModel =
      protocol === "anthropic"
        ? await anthropicResolvedModel(input.signal)
        : undefined;
    if (protocol === "anthropic") {
      validateAnthropicContinuationReplays(parameters[0], resolvedModel);
    }
    const step = await httpRequest(
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
              onDelta?.(output);
            };
            onDelta?.(emptyOutputDelta());
            restoreOutput();
            return httpRequest(
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
  return { close, complete, startStep };
}
