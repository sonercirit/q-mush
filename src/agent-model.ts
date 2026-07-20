import type { AgentReasoningEffort } from "./agent-configuration.ts";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelTurn,
  AgentToolCall,
} from "./agent-loop.ts";
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
const SYSTEM_PROMPT = `You are Q Mush, a careful coding agent operating in a user-selected workspace.
Inspect existing files before changing them. Make the smallest coherent change that satisfies the request. Use tools rather than guessing about repository contents. Preserve existing conventions, avoid secrets, and run focused checks after edits. Explain the result concisely when the work is complete. Never claim that a tool succeeded unless its result says so.`;

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
}

const STRING_PARAMETER = { type: "string" } as const;

function toolDefinition(options: {
  readonly description: string;
  readonly name: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}) {
  return {
    function: {
      description: options.description,
      name: options.name,
      parameters: {
        additionalProperties: false,
        properties: options.properties,
        ...(options.required === undefined
          ? {}
          : { required: options.required }),
        type: "object",
      },
    },
    type: "function",
  } as const;
}

const AGENT_TOOLS = [
  toolDefinition({
    description:
      "Read a UTF-8 text file in the workspace. Use offset and limit for large files.",
    name: "read_file",
    properties: {
      limit: { maximum: 2000, minimum: 1, type: "integer" },
      offset: { minimum: 1, type: "integer" },
      path: STRING_PARAMETER,
    },
    required: ["path"],
  }),
  toolDefinition({
    description:
      "List files recursively from a workspace-relative path. Common dependency and VCS directories are not traversed.",
    name: "list_files",
    properties: { path: STRING_PARAMETER },
  }),
  toolDefinition({
    description:
      "Search UTF-8 files for a literal string and return matching file names, line numbers, and lines.",
    name: "search_files",
    properties: { path: STRING_PARAMETER, query: STRING_PARAMETER },
    required: ["query"],
  }),
  toolDefinition({
    description:
      "Write a complete UTF-8 file, creating parent directories when necessary.",
    name: "write_file",
    properties: { content: STRING_PARAMETER, path: STRING_PARAMETER },
    required: ["path", "content"],
  }),
  toolDefinition({
    description:
      "Replace one exact, uniquely occurring text block in a UTF-8 file.",
    name: "edit_file",
    properties: {
      newText: STRING_PARAMETER,
      oldText: STRING_PARAMETER,
      path: STRING_PARAMETER,
    },
    required: ["path", "oldText", "newText"],
  }),
  toolDefinition({
    description:
      "Run a shell command in the workspace and return bounded stdout, stderr, and the exit status.",
    name: "run_command",
    properties: {
      command: STRING_PARAMETER,
      timeoutSeconds: { maximum: 300, minimum: 1, type: "integer" },
    },
    required: ["command"],
  }),
] as const;

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
  if (reasoningEffort === undefined) {
    return {};
  }

  return codexOAuth || provider === "openrouter"
    ? { reasoning: { effort: reasoningEffort } }
    : { reasoning_effort: reasoningEffort };
}

function requestBody(
  messages: readonly AgentConversationMessage[],
  model: string,
  provider: ProviderId,
  codexOAuth: boolean,
  reasoningEffort: AgentReasoningEffort | undefined,
): unknown {
  const reasoning = reasoningConfiguration(
    provider,
    codexOAuth,
    reasoningEffort,
  );

  if (!codexOAuth) {
    return {
      messages: [
        { content: SYSTEM_PROMPT, role: "system" },
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
    instructions: SYSTEM_PROMPT,
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
    toolCalls: (rawToolCalls ?? []).map(readToolCall),
  };
}

function readCodexTurn(value: unknown): AgentModelTurn {
  const output = readRequiredArray(
    value,
    "output",
    "The Codex model returned an invalid response",
  );
  const text: string[] = [];
  const toolCalls: AgentToolCall[] = [];

  for (const item of output) {
    if (!isRecord(item)) {
      throw new Error("The Codex model returned an invalid output item");
    }

    if (item["type"] === "function_call") {
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

      toolCalls.push({ arguments: arguments_, id, name });
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

  return { content: text.join(""), toolCalls };
}

async function readCodexEventStream(
  response: Response,
): Promise<AgentModelTurn> {
  const body = await response.text();

  if (body.length > 10 * 1_024 * 1_024) {
    throw new Error("The Codex model response was too large");
  }

  const streamedText: string[] = [];

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
      return turn.content.length === 0 && streamedText.length > 0
        ? { ...turn, content: streamedText.join("") }
        : turn;
    }

    if (
      isRecord(event) &&
      (event["type"] === "response.failed" || event["type"] === "error")
    ) {
      throw new Error("The Codex model failed to complete the request");
    }

    if (isRecord(event) && event["type"] === "response.output_text.delta") {
      const delta = event["delta"];

      if (typeof delta !== "string") {
        throw new Error("The Codex model returned an invalid text delta");
      }

      streamedText.push(delta);
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

  constructor(options: ChatCompletionsAgentModelOptions) {
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? ((request) => globalThis.fetch(request));
    this.#model = options.model;
    this.#provider = options.provider;
    this.#reasoningEffort = options.reasoningEffort ?? undefined;
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
