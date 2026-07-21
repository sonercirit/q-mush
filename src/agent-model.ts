import {
  completionMessages,
  completionSignal,
  type CompletionArguments,
  type OptionalTurn,
} from "./agent-completion.ts";
import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
} from "./agent-loop.ts";
import type { ModelRequestSleep } from "./agent-model-retry.ts";
import { AGENT_SYSTEM_PROMPT } from "./agent-prompt.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { isRecord } from "./auth-model.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import type {
  ProviderCredentialSource,
  ProviderId,
} from "./provider-credential-store.ts";
import { completeProviderHttp } from "./provider-http.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";
import {
  completeProviderWebSocket,
  ProviderWebSocketError,
  type ProviderWebSocketFactory as AgentModelWebSocket,
} from "./provider-websocket.ts";
import { createServerWebSocket } from "./server-websocket.ts";

const OPENAI_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_WEBSOCKET_URL = "wss://api.openai.com/v1/responses";
const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_CODEX_RESPONSES_WEBSOCKET_URL =
  "wss://chatgpt.com/backend-api/codex/responses";
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
export interface AgentProviderCredential {
  readonly accountId: string | null;
  readonly secret: string;
  readonly source: ProviderCredentialSource;
}

export type AgentModelFetch = (request: Request) => Promise<Response>;

interface ChatCompletionsAgentModelOptions {
  readonly credential: AgentProviderCredential;
  readonly fetch?: AgentModelFetch;
  readonly model: string;
  readonly onDelta?: (delta: ProviderTextDelta) => void;
  readonly provider: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
  readonly sleep?: ModelRequestSleep;
  readonly systemPrompt?: string;
  readonly webSocket?: AgentModelWebSocket;
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

  return provider === "openai"
    ? OPENAI_COMPLETIONS_URL
    : OPENROUTER_COMPLETIONS_URL;
}

function accessToken(
  provider: ProviderId,
  credential: AgentProviderCredential,
): string {
  return provider === "openai" && credential.source === "oauth"
    ? readOpenAiOAuthCredential(credential.secret).access
    : credential.secret;
}

export function agentProviderRequestHeaders(
  provider: ProviderId,
  credential: AgentProviderCredential,
  accept: string,
): Headers {
  const headers = new Headers({
    accept,
    authorization: `Bearer ${accessToken(provider, credential)}`,
    "content-type": "application/json",
  });

  if (provider === "openrouter") {
    headers.set("http-referer", "https://q-mush.local");
    headers.set("x-title", "Q Mush");
  } else if (credential.source === "oauth") {
    if (
      accept === "text/event-stream" ||
      accept === "application/websocket-events"
    ) {
      headers.set(
        "openai-beta",
        accept === "application/websocket-events"
          ? "responses_websockets=2026-02-06"
          : "responses=experimental",
      );
    }

    headers.set("originator", "q_mush");

    if (credential.accountId !== null) {
      headers.set("chatgpt-account-id", credential.accountId);
    }
  }

  return headers;
}

function modelMessage(message: AgentConversationMessage): unknown {
  switch (message.role) {
    case "user":
      return { content: message.content, role: "user" };
    case "assistant":
      return {
        content: message.content.length === 0 ? null : message.content,
        role: "assistant",
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                function: { arguments: call.arguments, name: call.name },
                id: call.id,
                type: "function",
              })),
            }),
      };
    case "tool":
      return {
        content: message.content,
        role: "tool",
        tool_call_id: message.toolCallId,
      };
  }
}

function responsesInput(message: AgentConversationMessage): readonly unknown[] {
  switch (message.role) {
    case "user":
      return [
        {
          content: [{ text: message.content, type: "input_text" }],
          role: "user",
          type: "message",
        },
      ];
    case "assistant": {
      const textItems =
        message.content.length === 0
          ? []
          : [
              {
                content: [{ text: message.content, type: "output_text" }],
                role: "assistant",
                type: "message",
              },
            ];
      return [
        ...textItems,
        ...message.toolCalls.map((call) => ({
          arguments: call.arguments,
          call_id: call.id,
          name: call.name,
          type: "function_call",
        })),
      ];
    }
    case "tool":
      return [
        {
          call_id: message.toolCallId,
          output: message.content,
          type: "function_call_output",
        },
      ];
  }
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

function requestBody(
  messages: readonly AgentConversationMessage[],
  model: string,
  provider: ProviderId,
  responsesProtocol: boolean,
  reasoningEffort: AgentReasoningEffort | undefined,
  systemPrompt: string,
  stream = false,
): unknown {
  const reasoning = reasoningConfiguration(
    provider,
    responsesProtocol,
    reasoningEffort,
  );

  if (!responsesProtocol) {
    return {
      messages: [
        { content: systemPrompt, role: "system" },
        ...messages.map(modelMessage),
      ],
      model,
      ...reasoning,
      ...(stream
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
      tool_choice: "auto",
      tools: AGENT_TOOLS,
    };
  }

  return {
    include: ["reasoning.encrypted_content"],
    input: messages.flatMap(responsesInput),
    instructions: systemPrompt,
    model,
    parallel_tool_calls: false,
    ...reasoning,
    store: false,
    ...(stream ? { stream: true } : {}),
    tool_choice: "auto",
    tools: AGENT_TOOLS.map(({ function: definition }) => ({
      ...definition,
      type: "function",
    })),
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
  readonly #fetch: AgentModelFetch;
  readonly #model: string;
  readonly #onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly #provider: ProviderId;
  readonly #reasoningEffort: AgentReasoningEffort | undefined;
  readonly #sleep: ModelRequestSleep | undefined;
  readonly #systemPrompt: string;
  readonly #webSocket: AgentModelWebSocket;

  constructor(options: ChatCompletionsAgentModelOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#model = options.model;
    this.#onDelta = options.onDelta;
    this.#provider = options.provider;
    this.#reasoningEffort = options.reasoningEffort ?? undefined;
    this.#sleep = options.sleep;
    this.#systemPrompt = options.systemPrompt ?? AGENT_SYSTEM_PROMPT;
    this.#webSocket = options.webSocket ?? defaultWebSocket;
  }

  async complete(...parameters: CompletionArguments): Promise<AgentModelTurn> {
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

  async #tryWebSocket(
    ...parameters: CompletionArguments
  ): Promise<OptionalTurn> {
    try {
      return await this.#completeWebSocket(...parameters);
    } catch (error) {
      const aborting = parameters[1]?.aborted === true;
      const started =
        error instanceof ProviderWebSocketError
          ? error.started
          : error instanceof DOMException && error.name === "AbortError";
      if (aborting || started) {
        throw error;
      }
      return undefined;
    }
  }

  #requestBody(
    messages: readonly AgentConversationMessage[],
    responsesProtocol: boolean,
    stream: boolean,
  ): unknown {
    return requestBody(
      messages,
      this.#model,
      this.#provider,
      responsesProtocol,
      this.#reasoningEffort,
      this.#systemPrompt,
      stream,
    );
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
  ): Promise<AgentModelTurn> {
    const { messages, signal } = completionInput(parameters);
    const headers = agentProviderRequestHeaders(
      this.#provider,
      this.#credential,
      "application/websocket-events",
    );
    const codexOAuth = usesCodexOAuth(this.#provider, this.#credential);
    const body = this.#requestBody(messages, true, false);

    if (!isRecord(body)) {
      throw new Error("The model request body was invalid");
    }

    return completeProviderWebSocket({
      body,
      createSocket: this.#webSocket,
      headers: headersRecord(headers),
      ...this.#webSocketOptions(signal),
      url: codexOAuth
        ? OPENAI_CODEX_RESPONSES_WEBSOCKET_URL
        : OPENAI_RESPONSES_WEBSOCKET_URL,
    });
  }

  #completeHttp(...parameters: CompletionArguments): Promise<AgentModelTurn> {
    const input = completionInput(parameters);
    const responsesProtocol = usesCodexOAuth(this.#provider, this.#credential);
    return completeProviderHttp(
      {
        body: this.#requestBody(input.messages, responsesProtocol, true),
        fetch: this.#fetch,
        headers: agentProviderRequestHeaders(
          this.#provider,
          this.#credential,
          "text/event-stream",
        ),
        onDelta: this.#onDelta,
        provider: this.#provider,
        responsesProtocol,
        sleep: this.#sleep,
        url: endpoint(this.#provider, this.#credential),
      },
      input.signal,
    );
  }
}
