import type {
  AgentModelTurn,
  AgentTokenUsage,
  AgentToolCall,
} from "../shared/agent-loop.ts";
import { isRecord, readRequiredArray } from "../shared/auth-model.ts";
import { requiredRecordString } from "../shared/json-record.ts";
import {
  createStreamBuffers,
  type StreamBuffers,
} from "./provider-stream-buffers.ts";
import {
  emitProviderDelta,
  providerTurn,
  sortedToolCalls,
} from "./provider-stream-helpers.ts";

type ProviderStreamProtocol =
  "chat_completions" | "chat_completions_json" | "responses";

export interface ProviderTextDelta {
  readonly content: string;
  readonly reset?: true;
  readonly thinking: string;
}

export interface ProviderStreamAccumulator {
  readonly completed: boolean;
  finish(): AgentModelTurn;
  push(event: unknown): void;
}

function readTokenCount(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const count = value[key];
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : undefined;
}

function usageRecord(
  value: unknown,
  usageKey: string,
): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && isRecord(value[usageKey])
    ? value[usageKey]
    : undefined;
}

function readTokenUsage(
  value: unknown,
  usageKey: string,
): AgentTokenUsage | null {
  const usage = usageRecord(value, usageKey) ?? {};

  const inputTokens =
    readTokenCount(usage, "input_tokens") ??
    readTokenCount(usage, "prompt_tokens");
  const outputTokens =
    readTokenCount(usage, "output_tokens") ??
    readTokenCount(usage, "completion_tokens");
  const inputDetails =
    usage["input_tokens_details"] ?? usage["prompt_tokens_details"];
  const cachedInputTokens = readTokenCount(inputDetails, "cached_tokens") ?? 0;
  const cacheWriteInputTokens =
    readTokenCount(inputDetails, "cache_write_tokens") ?? 0;

  return inputTokens === undefined || outputTokens === undefined
    ? null
    : {
        cacheWriteInputTokens,
        cachedInputTokens,
        inputTokens,
        outputTokens,
      };
}

function readCostUsd(value: unknown, usageKey: string): number | null {
  const cost = usageRecord(value, usageKey)?.["cost"];
  const parsed = typeof cost === "string" ? Number(cost) : cost;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : null;
}

function readContextTokens(value: unknown, usageKey: string): number | null {
  const usage = usageRecord(value, usageKey);
  return (
    readTokenCount(usage, "input_tokens") ??
    readTokenCount(usage, "prompt_tokens") ??
    null
  );
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  message: string,
): string {
  return requiredRecordString(value, key, message);
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

function readChatThinking(message: Readonly<Record<string, unknown>>): string {
  const value = message["reasoning"] ?? message["reasoning_content"];
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error("The model returned invalid reasoning content");
  }
  return typeof value === "string" && value.length > 0
    ? value
    : readReasoningDetails(message["reasoning_details"]);
}

function readChatToolCall(value: unknown): AgentToolCall {
  if (!isRecord(value) || !isRecord(value["function"])) {
    throw new Error("The model returned an invalid tool call");
  }
  const arguments_ = requiredString(
    value["function"],
    "arguments",
    "The model returned an invalid tool call",
  );
  const id = requiredString(
    value,
    "id",
    "The model returned an invalid tool call",
  );
  const name = requiredString(
    value["function"],
    "name",
    "The model returned an invalid tool call",
  );
  if (id.length === 0 || name.length === 0) {
    throw new Error("The model returned an invalid tool call");
  }
  return { arguments: arguments_, id, name };
}

function readChatTurn(value: unknown): AgentModelTurn {
  const choices = readRequiredArray(
    value,
    "choices",
    "The model returned an invalid completion",
  );
  const first = choices[0];
  if (!isRecord(first) || !isRecord(first["message"])) {
    throw new Error("The model returned an invalid completion");
  }
  const message = first["message"];
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
  return providerTurn(
    typeof content === "string" ? content : "",
    readContextTokens(value, "usage"),
    readChatThinking(message),
    (rawToolCalls ?? []).map(readChatToolCall),
    readCostUsd(value, "usage"),
    readTokenUsage(value, "usage"),
  );
}

function readResponsesToolCall(
  item: Readonly<Record<string, unknown>>,
): AgentToolCall {
  const message = "The Responses model returned an invalid tool call";
  return {
    arguments: requiredString(item, "arguments", message),
    id: requiredString(item, "call_id", message),
    name: requiredString(item, "name", message),
  };
}

function readResponsesSummary(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("The Responses model returned invalid reasoning content");
  }

  return value.map((part) => {
    if (
      !isRecord(part) ||
      part["type"] !== "summary_text" ||
      typeof part["text"] !== "string"
    ) {
      throw new Error("The Responses model returned invalid reasoning content");
    }

    return part["text"];
  });
}

function readResponsesTurn(value: unknown): AgentModelTurn {
  if (!isRecord(value)) {
    throw new Error("The Responses model returned an invalid response");
  }

  const output = readRequiredArray(
    value,
    "output",
    "The Responses model returned an invalid response",
  );
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: AgentToolCall[] = [];

  for (const value of output) {
    if (!isRecord(value)) {
      throw new Error("The Responses model returned an invalid output item");
    }

    if (value["type"] === "reasoning") {
      thinking.push(...readResponsesSummary(value["summary"]));
    } else if (value["type"] === "function_call") {
      toolCalls.push(readResponsesToolCall(value));
    } else if (value["type"] === "message") {
      const content = value["content"];

      if (!Array.isArray(content)) {
        throw new Error("The Responses model returned invalid message content");
      }

      for (const part of content) {
        if (isRecord(part) && part["type"] === "output_text") {
          text.push(
            requiredString(
              part,
              "text",
              "The Responses model returned invalid output text",
            ),
          );
        }
      }
    }
  }

  return {
    content: text.join(""),
    contextTokens: readContextTokens(value, "usage"),
    costUsd: readCostUsd(value, "usage"),
    thinking: thinking.join("\n\n"),
    tokenUsage: readTokenUsage(value, "usage"),
    toolCalls,
  };
}

function outputIndex(event: Readonly<Record<string, unknown>>): number {
  const value = event["output_index"];

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("The Responses model returned an invalid output index");
  }

  return value;
}

function stringDelta(
  event: Readonly<Record<string, unknown>>,
  kind: string,
): string {
  const delta = event["delta"];

  if (typeof delta !== "string") {
    throw new Error(`The provider returned an invalid ${kind} delta`);
  }

  return delta;
}

abstract class BufferedAccumulator {
  readonly buffers: StreamBuffers;

  constructor(onDelta?: (delta: ProviderTextDelta) => void) {
    this.buffers = createStreamBuffers(onDelta);
  }
}

function providerStreamError(event: Readonly<Record<string, unknown>>): string {
  const nested = isRecord(event["error"]) ? event["error"] : undefined;
  const detail = nested?.["message"] ?? event["message"];
  return typeof detail === "string" && detail.trim().length > 0
    ? `The provider failed to complete the request: ${detail.trim()}`
    : "The provider failed to complete the request";
}

class ResponsesAccumulator
  extends BufferedAccumulator
  implements ProviderStreamAccumulator
{
  #reasoningSummary:
    { readonly outputIndex: number; readonly summaryIndex: number } | undefined;
  readonly #toolCalls = new Map<number, AgentToolCall>();
  #completed: AgentModelTurn | undefined;

  get completed(): boolean {
    return this.#completed !== undefined;
  }

  finish(): AgentModelTurn {
    if (this.#completed === undefined) {
      throw new Error("The provider response ended before completion");
    }

    return providerTurn(
      this.#completed.content.length === 0 && this.buffers.text.length > 0
        ? this.buffers.text.join("")
        : this.#completed.content,
      this.#completed.contextTokens,
      this.#completed.thinking.length === 0 && this.buffers.thinking.length > 0
        ? this.buffers.thinking.join("")
        : this.#completed.thinking,
      this.#completed.toolCalls.length === 0 && this.#toolCalls.size > 0
        ? sortedToolCalls(this.#toolCalls)
        : this.#completed.toolCalls,
      this.#completed.costUsd,
      this.#completed.tokenUsage,
    );
  }

  push(value: unknown): void {
    if (!isRecord(value)) {
      throw new Error("The provider returned an invalid streaming event");
    }

    const type = value["type"];

    if (type === "response.completed") {
      this.#completed = readResponsesTurn(value["response"]);
      return;
    }

    if (type === "response.failed" || type === "error") {
      throw new Error(providerStreamError(value));
    }

    if (type === "response.output_item.added") {
      const item = value["item"];

      if (isRecord(item) && item["type"] === "function_call") {
        this.#toolCalls.set(outputIndex(value), readResponsesToolCall(item));
      }
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const index = outputIndex(value);
      const call = this.#toolCalls.get(index);

      if (call === undefined) {
        throw new Error(
          "The provider returned a tool-call delta before its call",
        );
      }

      this.#toolCalls.set(index, {
        ...call,
        arguments: call.arguments + stringDelta(value, "tool-call"),
      });
      return;
    }

    if (type === "response.reasoning_summary_text.delta") {
      const outputIndexValue = outputIndex(value);
      const summaryIndexValue = value["summary_index"];
      if (
        typeof summaryIndexValue !== "number" ||
        !Number.isSafeInteger(summaryIndexValue) ||
        summaryIndexValue < 0
      ) {
        throw new Error(
          "The Responses model returned an invalid summary index",
        );
      }
      const separator =
        this.#reasoningSummary !== undefined &&
        (this.#reasoningSummary.outputIndex !== outputIndexValue ||
          this.#reasoningSummary.summaryIndex !== summaryIndexValue)
          ? "\n\n"
          : "";
      const thinking = separator + stringDelta(value, "reasoning");
      this.#reasoningSummary = {
        outputIndex: outputIndexValue,
        summaryIndex: summaryIndexValue,
      };
      this.buffers.thinking.push(thinking);
      emitProviderDelta(this.buffers.onDelta, "", thinking);
      return;
    }

    if (type === "response.output_text.delta") {
      const content = stringDelta(value, "text");
      this.buffers.text.push(content);
      emitProviderDelta(this.buffers.onDelta, content, "");
    }
  }
}

interface PartialChatToolCall {
  arguments: string;
  id: string;
  name: string;
}

function readChatDelta(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value["choices"])) {
    throw new Error("The model returned an invalid completion chunk");
  }

  const choices: unknown[] = value["choices"];
  const first: unknown = choices[0];
  if (!isRecord(first)) {
    return {};
  }

  return isRecord(first["delta"])
    ? first["delta"]
    : isRecord(first["message"])
      ? first["message"]
      : {};
}

function optionalDeltaString(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const provided = value[key];

    if (provided !== undefined && provided !== null) {
      if (typeof provided !== "string") {
        throw new Error("The model returned invalid streaming content");
      }
      return provided;
    }
  }

  return "";
}

class ChatCompletionsAccumulator
  extends BufferedAccumulator
  implements ProviderStreamAccumulator
{
  #contextTokens: number | null = null;
  #costUsd: number | null = null;
  #tokenUsage: AgentTokenUsage | null = null;
  readonly #toolCalls = new Map<number, PartialChatToolCall>();

  readonly completed = false;

  finish(): AgentModelTurn {
    return providerTurn(
      this.buffers.text.join(""),
      this.#contextTokens,
      this.buffers.thinking.join(""),
      sortedToolCalls(this.#toolCalls),
      this.#costUsd,
      this.#tokenUsage,
    );
  }

  push(value: unknown): void {
    const delta = readChatDelta(value);
    const content = optionalDeltaString(delta, ["content"]);
    const thinking = optionalDeltaString(delta, [
      "reasoning",
      "reasoning_content",
    ]);

    if (content.length > 0) {
      this.buffers.text.push(content);
    }
    if (thinking.length > 0) {
      this.buffers.thinking.push(thinking);
    }
    emitProviderDelta(this.buffers.onDelta, content, thinking);

    const rawToolCalls = delta["tool_calls"];
    if (rawToolCalls !== undefined && !Array.isArray(rawToolCalls)) {
      throw new Error("The model returned invalid streaming tool calls");
    }

    for (const [fallbackIndex, rawCall] of (rawToolCalls ?? []).entries()) {
      if (!isRecord(rawCall)) {
        throw new Error("The model returned an invalid streaming tool call");
      }

      const indexValue = rawCall["index"];
      const index = indexValue === undefined ? fallbackIndex : indexValue;
      if (typeof index !== "number" || !Number.isSafeInteger(index)) {
        throw new Error("The model returned an invalid streaming tool index");
      }

      const existing = this.#toolCalls.get(index) ?? {
        arguments: "",
        id: "",
        name: "",
      };
      const function_ = rawCall["function"];
      const argumentsDelta = isRecord(function_)
        ? optionalDeltaString(function_, ["arguments"])
        : "";
      const nameDelta = isRecord(function_)
        ? optionalDeltaString(function_, ["name"])
        : "";
      const idDelta = optionalDeltaString(rawCall, ["id"]);
      this.#toolCalls.set(index, {
        arguments: existing.arguments + argumentsDelta,
        id: existing.id + idDelta,
        name: existing.name + nameDelta,
      });
    }

    const contextTokens = readContextTokens(value, "usage");
    if (contextTokens !== null) {
      this.#contextTokens = contextTokens;
    }
    const costUsd = readCostUsd(value, "usage");
    if (costUsd !== null) {
      this.#costUsd = costUsd;
    }
    const tokenUsage = readTokenUsage(value, "usage");
    if (tokenUsage !== null) {
      this.#tokenUsage = tokenUsage;
    }
  }
}

class JsonChatCompletionsAccumulator implements ProviderStreamAccumulator {
  #turn: AgentModelTurn | undefined;

  get completed(): boolean {
    return this.#turn !== undefined;
  }

  finish(): AgentModelTurn {
    if (this.#turn === undefined) {
      throw new Error("The provider response ended before completion");
    }
    return this.#turn;
  }

  push(value: unknown): void {
    this.#turn = readChatTurn(value);
  }
}

export function createProviderStreamAccumulator(
  protocol: ProviderStreamProtocol,
  onDelta?: (delta: ProviderTextDelta) => void,
): ProviderStreamAccumulator {
  if (protocol === "chat_completions_json") {
    return new JsonChatCompletionsAccumulator();
  }
  return protocol === "responses"
    ? new ResponsesAccumulator(onDelta)
    : new ChatCompletionsAccumulator(onDelta);
}
