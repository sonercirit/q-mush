import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
  AgentToolCall,
} from "./agent-loop.ts";
import { AGENT_SYSTEM_PROMPT } from "./agent-prompt.ts";
import { AGENT_TOOLS } from "./agent-tools.ts";
import { isRecord, readRequiredArray } from "./auth-model.ts";
import { readOpenAiOAuthCredential } from "./openai-credential.ts";
import type {
  ProviderCredentialSource,
  ProviderId,
} from "./provider-credential-store.ts";

const OPENAI_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";
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
  readonly provider: ProviderId;
  readonly reasoningEffort?: AgentReasoningEffort | null;
  readonly systemPrompt?: string;
}

function providerName(provider: ProviderId): string {
  return provider === "openai" ? "OpenAI" : "OpenRouter";
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
    if (accept === "text/event-stream") {
      headers.set("openai-beta", "responses=experimental");
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
  codexOAuth: boolean,
  reasoningEffort: AgentReasoningEffort | undefined,
  systemPrompt: string,
): unknown {
  const reasoning = reasoningConfiguration(
    provider,
    codexOAuth,
    reasoningEffort,
  );

  if (!codexOAuth) {
    return {
      messages: [
        { content: systemPrompt, role: "system" },
        ...messages.map(modelMessage),
      ],
      model,
      ...reasoning,
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
    stream: true,
    tool_choice: "auto",
    tools: AGENT_TOOLS.map(({ function: definition }) => ({
      ...definition,
      type: "function",
    })),
  };
}

function readToolCall(value: unknown): AgentToolCall {
  if (!isRecord(value) || !isRecord(value["function"])) {
    throw new Error("The model returned an invalid tool call");
  }

  const arguments_ = value["function"]["arguments"];
  const id = value["id"];
  const name = value["function"]["name"];

  if (
    typeof arguments_ !== "string" ||
    typeof id !== "string" ||
    id.length === 0 ||
    typeof name !== "string" ||
    name.length === 0
  ) {
    throw new Error("The model returned an invalid tool call");
  }

  return { arguments: arguments_, id, name };
}

function readReasoningDetails(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (!Array.isArray(value)) {
    throw new Error("The model returned invalid reasoning details");
  }

  const thinking: string[] = [];

  for (const detail of value) {
    if (!isRecord(detail)) {
      throw new Error("The model returned invalid reasoning details");
    }

    const type = detail["type"];
    const content =
      type === "reasoning.summary"
        ? detail["summary"]
        : type === "reasoning.text"
          ? detail["text"]
          : undefined;

    if (content !== undefined && typeof content !== "string") {
      throw new Error("The model returned invalid reasoning details");
    }

    if (typeof content === "string" && content.length > 0) {
      thinking.push(content);
    }
  }

  return thinking.join("\n\n");
}

function readMessageThinking(
  message: Readonly<Record<string, unknown>>,
): string {
  const value = message["reasoning"] ?? message["reasoning_content"];

  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error("The model returned invalid reasoning content");
  }

  return typeof value === "string" && value.length > 0
    ? value
    : readReasoningDetails(message["reasoning_details"]);
}

function readTurn(value: unknown): AgentModelTurn {
  const choices = readRequiredArray(
    value,
    "choices",
    "The model returned an invalid completion",
  );
  const firstChoice: unknown = choices[0];

  if (!isRecord(firstChoice) || !isRecord(firstChoice["message"])) {
    throw new Error("The model returned an invalid completion");
  }

  const message = firstChoice["message"];
  const content = message["content"];
  const rawToolCalls = message["tool_calls"];

  if (
    content !== null &&
    content !== undefined &&
    typeof content !== "string"
  ) {
    throw new Error("The model returned invalid message content");
  }

  if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) {
    throw new Error("The model returned invalid tool calls");
  }

  return {
    content: typeof content === "string" ? content : "",
    thinking: readMessageThinking(message),
    toolCalls: (rawToolCalls ?? []).map(readToolCall),
  };
}

function readCodexSummary(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("The Codex model returned invalid reasoning content");
  }

  return value.map((part) => {
    if (
      !isRecord(part) ||
      part["type"] !== "summary_text" ||
      typeof part["text"] !== "string"
    ) {
      throw new Error("The Codex model returned invalid reasoning content");
    }

    return part["text"];
  });
}

function readCodexToolCall(
  item: Readonly<Record<string, unknown>>,
): AgentToolCall {
  const arguments_ = item["arguments"];
  const id = item["call_id"];
  const name = item["name"];

  if (
    typeof arguments_ !== "string" ||
    typeof id !== "string" ||
    typeof name !== "string"
  ) {
    throw new Error("The Codex model returned an invalid tool call");
  }

  return { arguments: arguments_, id, name };
}

function readCodexOutputItem(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error("The Codex model returned an invalid output item");
  }

  return value;
}

function readCodexTurn(value: unknown): AgentModelTurn {
  const output = readRequiredArray(
    value,
    "output",
    "The Codex model returned an invalid response",
  );
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: AgentToolCall[] = [];

  for (const value of output) {
    const item = readCodexOutputItem(value);

    if (item["type"] === "reasoning") {
      thinking.push(...readCodexSummary(item["summary"]));
    } else if (item["type"] === "function_call") {
      toolCalls.push(readCodexToolCall(item));
    } else if (item["type"] === "message") {
      const content = item["content"];

      if (!Array.isArray(content)) {
        throw new Error("The Codex model returned invalid message content");
      }

      for (const part of content) {
        if (isRecord(part) && part["type"] === "output_text") {
          const outputText = part["text"];

          if (typeof outputText !== "string") {
            throw new Error("The Codex model returned invalid output text");
          }

          text.push(outputText);
        }
      }
    }
  }

  return { content: text.join(""), thinking: thinking.join("\n\n"), toolCalls };
}

function readCodexOutputIndex(
  event: Readonly<Record<string, unknown>>,
): number {
  const outputIndex = event["output_index"];

  if (
    typeof outputIndex !== "number" ||
    !Number.isSafeInteger(outputIndex) ||
    outputIndex < 0
  ) {
    throw new Error("The Codex model returned an invalid output index");
  }

  return outputIndex;
}

function updateStreamedCodexToolCalls(
  event: Readonly<Record<string, unknown>>,
  toolCalls: Map<number, AgentToolCall>,
): void {
  if (event["type"] === "response.output_item.added") {
    const item = readCodexOutputItem(event["item"]);

    if (item["type"] === "function_call") {
      toolCalls.set(readCodexOutputIndex(event), readCodexToolCall(item));
    }

    return;
  }

  const outputIndex = readCodexOutputIndex(event);
  const call = toolCalls.get(outputIndex);
  const delta = event["delta"];

  if (call === undefined || typeof delta !== "string") {
    throw new Error("The Codex model returned an invalid tool-call delta");
  }

  toolCalls.set(outputIndex, {
    ...call,
    arguments: call.arguments + delta,
  });
}

function appendCodexDelta(
  event: Readonly<Record<string, unknown>>,
  destination: string[],
  kind: "reasoning" | "text",
): void {
  const delta = event["delta"];

  if (typeof delta !== "string") {
    throw new Error(`The Codex model returned an invalid ${kind} delta`);
  }

  destination.push(delta);
}

async function readCodexEventStream(
  response: Response,
): Promise<AgentModelTurn> {
  const body = await response.text();

  if (body.length > 10 * 1_024 * 1_024) {
    throw new Error("The Codex model response was too large");
  }

  const streamedText: string[] = [];
  const streamedThinking: string[] = [];
  const streamedToolCalls = new Map<number, AgentToolCall>();

  for (const block of body.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (data.length === 0 || data === "[DONE]") {
      continue;
    }

    let event: unknown;

    try {
      event = JSON.parse(data);
    } catch {
      throw new Error("The Codex model returned an invalid event stream");
    }

    if (isRecord(event) && event["type"] === "response.completed") {
      const turn = readCodexTurn(event["response"]);
      return {
        ...turn,
        content:
          turn.content.length === 0 && streamedText.length > 0
            ? streamedText.join("")
            : turn.content,
        thinking:
          turn.thinking.length === 0 && streamedThinking.length > 0
            ? streamedThinking.join("")
            : turn.thinking,
        toolCalls:
          turn.toolCalls.length === 0 && streamedToolCalls.size > 0
            ? [...streamedToolCalls.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, call]) => call)
            : turn.toolCalls,
      };
    }

    if (
      isRecord(event) &&
      (event["type"] === "response.failed" || event["type"] === "error")
    ) {
      throw new Error("The Codex model failed to complete the request");
    }

    if (
      isRecord(event) &&
      (event["type"] === "response.output_item.added" ||
        event["type"] === "response.function_call_arguments.delta")
    ) {
      updateStreamedCodexToolCalls(event, streamedToolCalls);
    }

    if (
      isRecord(event) &&
      event["type"] === "response.reasoning_summary_text.delta"
    ) {
      appendCodexDelta(event, streamedThinking, "reasoning");
    }

    if (isRecord(event) && event["type"] === "response.output_text.delta") {
      appendCodexDelta(event, streamedText, "text");
    }
  }

  throw new Error("The Codex model response ended before completion");
}

export class ChatCompletionsAgentModel implements AgentModel {
  readonly #credential: AgentProviderCredential;
  readonly #fetch: AgentModelFetch;
  readonly #model: string;
  readonly #provider: ProviderId;
  readonly #reasoningEffort: AgentReasoningEffort | undefined;
  readonly #systemPrompt: string;

  constructor(options: ChatCompletionsAgentModelOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#model = options.model;
    this.#provider = options.provider;
    this.#reasoningEffort = options.reasoningEffort ?? undefined;
    this.#systemPrompt = options.systemPrompt ?? AGENT_SYSTEM_PROMPT;
  }

  async complete(
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ): Promise<AgentModelTurn> {
    const codexOAuth = usesCodexOAuth(this.#provider, this.#credential);
    const request = new Request(endpoint(this.#provider, this.#credential), {
      body: JSON.stringify(
        requestBody(
          messages,
          this.#model,
          this.#provider,
          codexOAuth,
          this.#reasoningEffort,
          this.#systemPrompt,
        ),
      ),
      headers: agentProviderRequestHeaders(
        this.#provider,
        this.#credential,
        codexOAuth ? "text/event-stream" : "application/json",
      ),
      method: "POST",
      ...(signal === undefined ? {} : { signal }),
    });
    const response = await this.#fetch(request);

    if (!response.ok) {
      throw new Error(
        `${providerName(this.#provider)} request failed with status ${String(response.status)}`,
      );
    }

    if (codexOAuth) {
      return readCodexEventStream(response);
    }

    const value: unknown = await response.json();
    return readTurn(value);
  }
}
