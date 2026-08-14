import type {
  AgentModelStep,
  AgentStepTruncation,
  AgentTokenUsage,
} from "../shared/agent-loop.ts";
import { isRecord } from "../shared/auth-model.ts";
import { requiredRecordString } from "../shared/json-record.ts";
import { readNonNegativeSafeInteger } from "../shared/validation.ts";
import {
  isProviderStreamErrorEvent,
  readProviderStreamError,
} from "./provider-error.ts";
import { BufferedAccumulator } from "./provider-stream-buffers.ts";
import {
  providerEventIndex,
  providerStep,
  type PartialProviderToolCall,
} from "./provider-stream-helpers.ts";

const INVALID_EVENT = "The Anthropic model returned an invalid event";
const INVALID_DELTA = "The Anthropic model returned an invalid content delta";
const INVALID_BLOCK = "The Anthropic model returned an invalid content block";

function tokenCount(value: unknown): number {
  return readNonNegativeSafeInteger(value) ?? 0;
}

// Anthropic reports fresh, cache-read, and cache-write input separately, while
// Q Mush records the total prompt size like the OpenAI-compatible providers.
function anthropicUsage(
  usage: Readonly<Record<string, unknown>>,
  outputTokens: number,
): AgentTokenUsage {
  const cachedInputTokens = tokenCount(usage["cache_read_input_tokens"]);
  const cacheWriteInputTokens = tokenCount(
    usage["cache_creation_input_tokens"],
  );
  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens:
      tokenCount(usage["input_tokens"]) +
      cachedInputTokens +
      cacheWriteInputTokens,
    outputTokens,
  };
}

function toolUseCall(
  block: Readonly<Record<string, unknown>>,
  arguments_: string,
): PartialProviderToolCall {
  return {
    arguments: arguments_,
    id: requiredRecordString(block, "id", INVALID_BLOCK),
    name: requiredRecordString(block, "name", INVALID_BLOCK),
  };
}

function readTruncation(delta: unknown): AgentStepTruncation | undefined {
  if (!isRecord(delta)) {
    return undefined;
  }
  const stopReason = delta["stop_reason"];
  return stopReason === "max_tokens" ||
    stopReason === "model_context_window_exceeded"
    ? stopReason
    : undefined;
}

export class AnthropicStreamAccumulator extends BufferedAccumulator {
  readonly protocol = "anthropic" as const;
  #stopped = false;
  #truncation: AgentStepTruncation | undefined;
  #usage: AgentTokenUsage | null = null;

  finish(): AgentModelStep {
    if (!this.#stopped) {
      throw new Error("The provider response ended before completion");
    }

    const usage = this.#usage;
    const step = providerStep(
      this.buffers.text.join(""),
      usage === null ? null : usage.inputTokens,
      this.buffers.thinking.join(""),
      this.recordedToolCalls(),
    );
    return {
      ...step,
      tokenUsage: usage,
      ...(this.#truncation === undefined
        ? {}
        : { truncation: this.#truncation }),
    };
  }

  get completed(): boolean {
    return this.#stopped;
  }

  push(streamEvent: unknown): void {
    const parsed = this.readEvent(streamEvent, INVALID_EVENT);

    if (isProviderStreamErrorEvent(parsed)) {
      throw readProviderStreamError(parsed);
    }

    switch (parsed["type"]) {
      case "message_start":
        this.#readUsage(parsed["message"]);
        return;
      case "content_block_start":
        this.#startBlock(parsed);
        return;
      case "content_block_delta":
        this.#pushDelta(parsed);
        return;
      case "message_delta":
        // Length stops surface as step truncation; other reasons (end_turn,
        // tool_use, stop_sequence, pause_turn, refusal) end steps normally.
        this.#truncation ??= readTruncation(parsed["delta"]);
        this.#readOutputTokens(parsed["usage"]);
        return;
      case "message_stop":
        this.#stopped = true;
        return;
      case "message":
        this.#readCompleteMessage(parsed);
        return;
      default:
        return;
    }
  }

  #readUsage(message: unknown): void {
    if (!isRecord(message) || !isRecord(message["usage"])) {
      return;
    }

    const usage = message["usage"];
    this.#usage = anthropicUsage(usage, tokenCount(usage["output_tokens"]));
  }

  #readOutputTokens(usage: unknown): void {
    if (!isRecord(usage)) {
      return;
    }

    const outputTokens = tokenCount(usage["output_tokens"]);
    this.#usage =
      this.#usage === null
        ? anthropicUsage(usage, outputTokens)
        : { ...this.#usage, outputTokens };
  }

  #startBlock(event: Readonly<Record<string, unknown>>): void {
    const block = event["content_block"];

    if (!isRecord(block)) {
      throw new Error(INVALID_BLOCK);
    }

    if (block["type"] === "tool_use") {
      this.registerToolCall(
        providerEventIndex(event, "index", "content block index"),
        toolUseCall(block, ""),
      );
    }
  }

  #pushDelta(event: Readonly<Record<string, unknown>>): void {
    const delta = event["delta"];

    if (!isRecord(delta)) {
      throw new Error(INVALID_DELTA);
    }

    if (delta["type"] === "text_delta") {
      this.pushText(requiredRecordString(delta, "text", INVALID_DELTA));
      return;
    }

    if (delta["type"] === "thinking_delta") {
      this.pushThinking(requiredRecordString(delta, "thinking", INVALID_DELTA));
      return;
    }

    if (delta["type"] === "input_json_delta") {
      this.appendToolCallArguments(
        providerEventIndex(event, "index", "content block index"),
        requiredRecordString(delta, "partial_json", INVALID_DELTA),
      );
    }
  }

  // Non-streaming responses return one complete message object instead of an
  // event sequence.
  #readCompleteMessage(message: Readonly<Record<string, unknown>>): void {
    const content = message["content"];

    if (!Array.isArray(content)) {
      throw new Error("The Anthropic model returned an invalid message");
    }

    for (const [index, block] of content.entries()) {
      if (!isRecord(block)) {
        throw new Error(INVALID_BLOCK);
      }
      this.#readCompleteBlock(index, block);
    }

    this.#truncation ??= readTruncation(message);
    this.#readUsage(message);
    this.#stopped = true;
  }

  #readCompleteBlock(
    index: number,
    block: Readonly<Record<string, unknown>>,
  ): void {
    if (block["type"] === "text") {
      this.pushText(requiredRecordString(block, "text", INVALID_BLOCK));
      return;
    }

    if (block["type"] === "thinking") {
      this.pushThinking(requiredRecordString(block, "thinking", INVALID_BLOCK));
      return;
    }

    if (block["type"] === "tool_use") {
      this.registerToolCall(
        index,
        toolUseCall(block, JSON.stringify(block["input"] ?? {})),
      );
    }
  }
}
