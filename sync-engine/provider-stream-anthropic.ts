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
import {
  createAnthropicReplayCapture,
  type AnthropicReplayCapture,
} from "./provider-stream-anthropic-replay.ts";
import { BufferedAccumulator } from "./provider-stream-buffers.ts";
import {
  providerEventIndex,
  providerStep,
  type PartialProviderToolCall,
} from "./provider-stream-helpers.ts";

const INVALID_EVENT = "The Anthropic model returned an invalid event";
const INVALID_DELTA = "The Anthropic model returned an invalid content delta";
const INVALID_BLOCK = "The Anthropic model returned an invalid content block";
const INVALID_MESSAGE = "The Anthropic model returned an invalid message";

function tokenCount(value: unknown): number {
  return readNonNegativeSafeInteger(value) ?? 0;
}

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
  if (!isRecord(delta)) return undefined;
  const stopReason = delta["stop_reason"];
  return stopReason === "max_tokens" ||
    stopReason === "model_context_window_exceeded"
    ? stopReason
    : undefined;
}

function eventIndex(
  event: Readonly<Record<string, unknown>>,
): number | undefined {
  return readNonNegativeSafeInteger(event["index"]);
}

export class AnthropicStreamAccumulator extends BufferedAccumulator {
  readonly protocol = "anthropic" as const;
  readonly #requestModel: string;
  readonly #replay: AnthropicReplayCapture;
  #pauseTurn = false;
  #stopped = false;
  #truncation: AgentStepTruncation | undefined;
  #usage: AgentTokenUsage | null = null;

  constructor(
    model: string,
    provenance: string,
    onDelta?: ConstructorParameters<typeof BufferedAccumulator>[0],
  ) {
    super(onDelta);
    this.#requestModel = model;
    this.#replay = createAnthropicReplayCapture(provenance);
  }

  finish(): AgentModelStep {
    if (!this.#stopped) {
      throw new Error("The provider response ended before completion");
    }
    const providerReplay = this.#replay.finish();
    const usage = this.#usage;
    const step = providerStep(
      this.buffers.text.join(""),
      usage === null ? null : usage.inputTokens,
      this.buffers.thinking.join(""),
      this.recordedToolCalls(),
    );
    return {
      ...step,
      ...(step.toolCalls.length > 0 && providerReplay === undefined
        ? { providerContinuation: "anthropic_replay_unavailable" as const }
        : this.#pauseTurn
          ? { providerContinuation: "anthropic_pause_turn" as const }
          : {}),
      ...(providerReplay === undefined
        ? {}
        : {
            providerReplay:
              providerReplay.model === this.#requestModel
                ? providerReplay
                : { ...providerReplay, requestModel: this.#requestModel },
          }),
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
    const event = this.readEvent(streamEvent, INVALID_EVENT);
    if (isProviderStreamErrorEvent(event)) {
      throw readProviderStreamError(event);
    }
    switch (event["type"]) {
      case "message_start":
        this.#readMessageStart(event["message"]);
        return;
      case "content_block_start":
        this.#startBlock(event);
        return;
      case "content_block_delta":
        this.#pushDelta(event);
        return;
      case "content_block_stop":
        this.#replay.stop(eventIndex(event));
        return;
      case "message_delta":
        this.#readStopReason(event["delta"]);
        this.#readOutputTokens(event["usage"]);
        return;
      case "message_stop":
        this.#stopped = true;
        return;
      case "message":
        this.#readCompleteMessage(event);
        return;
      default:
        return;
    }
  }

  #readMessageStart(message: unknown): void {
    this.#readUsage(message);
    if (isRecord(message)) {
      this.#replay.readModel(message["model"]);
      this.#replay.readContainer(message["container"]);
    }
  }

  #readUsage(message: unknown): void {
    if (!isRecord(message) || !isRecord(message["usage"])) return;
    const usage = message["usage"];
    this.#usage = anthropicUsage(usage, tokenCount(usage["output_tokens"]));
  }

  #readOutputTokens(usage: unknown): void {
    if (!isRecord(usage)) return;
    const outputTokens = tokenCount(usage["output_tokens"]);
    this.#usage =
      this.#usage === null
        ? anthropicUsage(usage, outputTokens)
        : { ...this.#usage, outputTokens };
  }

  #readStopReason(value: unknown): void {
    if (!isRecord(value)) return;
    this.#truncation ??= readTruncation(value);
    this.#pauseTurn ||= value["stop_reason"] === "pause_turn";
    this.#replay.readContainer(value["container"]);
  }

  #startBlock(event: Readonly<Record<string, unknown>>): void {
    const block = event["content_block"];
    if (!isRecord(block)) throw new Error(INVALID_BLOCK);
    const index =
      block["type"] === "tool_use"
        ? providerEventIndex(event, "index", "content block index")
        : eventIndex(event);
    this.#replay.start(index, block);
    if (block["type"] === "tool_use" && index !== undefined) {
      this.registerToolCall(index, toolUseCall(block, ""));
    }
  }

  #pushDelta(event: Readonly<Record<string, unknown>>): void {
    const delta = event["delta"];
    if (!isRecord(delta)) throw new Error(INVALID_DELTA);
    const index = eventIndex(event);
    switch (delta["type"]) {
      case "text_delta":
        this.pushText(requiredRecordString(delta, "text", INVALID_DELTA));
        break;
      case "thinking_delta":
        this.pushThinking(
          requiredRecordString(delta, "thinking", INVALID_DELTA),
        );
        break;
      case "input_json_delta":
        this.#appendToolInput(event);
        break;
      default:
        break;
    }
    this.#replay.delta(index, delta);
  }

  #appendToolInput(event: Readonly<Record<string, unknown>>): void {
    const index = eventIndex(event);
    const delta = event["delta"];
    if (index === undefined || !this.toolCalls.has(index) || !isRecord(delta)) {
      return;
    }
    this.appendToolCallArguments(
      index,
      requiredRecordString(delta, "partial_json", INVALID_DELTA),
    );
  }

  #readCompleteMessage(message: Readonly<Record<string, unknown>>): void {
    this.#replay.readModel(message["model"]);
    const content = message["content"];
    if (!Array.isArray(content)) throw new Error(INVALID_MESSAGE);
    for (const [index, value] of content.entries()) {
      if (!isRecord(value)) throw new Error(INVALID_BLOCK);
      this.#readCompleteBlock(index, value);
    }
    this.#readStopReason(message);
    this.#readUsage(message);
    this.#stopped = true;
  }

  #readCompleteBlock(
    index: number,
    block: Readonly<Record<string, unknown>>,
  ): void {
    this.#replay.complete(index, block);
    switch (block["type"]) {
      case "text":
        this.pushText(requiredRecordString(block, "text", INVALID_BLOCK));
        return;
      case "thinking":
        this.pushThinking(
          requiredRecordString(block, "thinking", INVALID_BLOCK),
        );
        return;
      case "tool_use": {
        // A parsed JSON body always re-serializes; the whole event came from
        // JSON.parse.
        const input = JSON.stringify(block["input"] ?? {});
        this.registerToolCall(index, toolUseCall(block, input));
        return;
      }
      default:
        return;
    }
  }
}
