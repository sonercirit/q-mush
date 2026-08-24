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
import { createAnthropicReplayCapture } from "./provider-stream-anthropic-replay.ts";
import { createBufferedAccumulator } from "./provider-stream-buffers.ts";
import {
  accumulatorResult,
  providerEventIndex,
  providerStep,
  type PartialProviderToolCall,
} from "./provider-stream-helpers.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

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

type AnthropicEventKind =
  | "content_block_delta"
  | "content_block_start"
  | "content_block_stop"
  | "message"
  | "message_delta"
  | "message_start"
  | "message_stop";
type AnthropicDeltaKind =
  | "input_json_delta"
  | "text_delta"
  | "thinking_delta";
type AnthropicBlockKind = "text" | "thinking" | "tool_use";

function isDispatchKey<Kind extends string>(
  handlers: Readonly<Record<Kind, unknown>>,
  value: unknown,
): value is Kind {
  return typeof value === "string" && Object.hasOwn(handlers, value);
}

export function createAnthropicStreamAccumulator(
  model: string,
  provenance: string,
  onDelta?: (delta: ProviderTextDelta) => void,
) {
  const accumulator = createBufferedAccumulator(onDelta);
  let pauseTurn = false;
  let stopped = false;
  let truncation: AgentStepTruncation | undefined;
  let usage: AgentTokenUsage | null = null;

  const requestModel = model;
  const replay = createAnthropicReplayCapture(provenance);

  const finish = (): AgentModelStep => {
    if (!stopped) {
      throw new Error("The provider response ended before completion");
    }
    const providerReplay = replay.finish();
    const finalUsage = usage;
    const step = providerStep(
      accumulator.buffers.text.join(""),
      finalUsage === null ? null : finalUsage.inputTokens,
      accumulator.buffers.thinking.join(""),
      accumulator.recordedToolCalls(),
    );
    return {
      ...step,
      ...(step.toolCalls.length > 0 && providerReplay === undefined
        ? { providerContinuation: "anthropic_replay_unavailable" as const }
        : pauseTurn
          ? { providerContinuation: "anthropic_pause_turn" as const }
          : {}),
      ...(providerReplay === undefined
        ? {}
        : {
            providerReplay:
              providerReplay.model === requestModel
                ? providerReplay
                : { ...providerReplay, requestModel: requestModel },
          }),
      tokenUsage: finalUsage,
      ...(truncation === undefined ? {} : { truncation: truncation }),
    };
  };

  const completed = (): boolean => {
    return stopped;
  };

  const push = (streamEvent: unknown): void => {
    const event = accumulator.readEvent(streamEvent, INVALID_EVENT);
    if (isProviderStreamErrorEvent(event)) {
      throw readProviderStreamError(event);
    }
    const kind = event["type"];
    if (isDispatchKey(eventHandlers, kind)) {
      eventHandlers[kind](event);
      return;
    }
    // Anthropic may add ignorable event kinds at runtime.
  };

  const readMessageStart = (message: unknown): void => {
    readUsage(message);
    if (isRecord(message)) {
      replay.readModel(message["model"]);
      replay.readContainer(message["container"]);
    }
  };

  const readUsage = (message: unknown): void => {
    if (!isRecord(message) || !isRecord(message["usage"])) return;
    const usageRecord = message["usage"];
    usage = anthropicUsage(
      usageRecord,
      tokenCount(usageRecord["output_tokens"]),
    );
  };

  const readOutputTokens = (usageValue: unknown): void => {
    if (!isRecord(usageValue)) return;
    const outputTokens = tokenCount(usageValue["output_tokens"]);
    usage =
      usage === null
        ? anthropicUsage(usageValue, outputTokens)
        : { ...usage, outputTokens };
  };

  const readStopReason = (value: unknown): void => {
    if (!isRecord(value)) return;
    truncation ??= readTruncation(value);
    pauseTurn ||= value["stop_reason"] === "pause_turn";
    replay.readContainer(value["container"]);
  };

  const startBlock = (event: Readonly<Record<string, unknown>>): void => {
    const block = event["content_block"];
    if (!isRecord(block)) throw new Error(INVALID_BLOCK);
    const index =
      block["type"] === "tool_use"
        ? providerEventIndex(event, "index", "content block index")
        : eventIndex(event);
    replay.start(index, block);
    if (block["type"] === "tool_use" && index !== undefined) {
      accumulator.registerToolCall(index, toolUseCall(block, ""));
    }
  };

  const pushDelta = (event: Readonly<Record<string, unknown>>): void => {
    const delta = event["delta"];
    if (!isRecord(delta)) throw new Error(INVALID_DELTA);
    const index = eventIndex(event);
    const kind = delta["type"];
    if (isDispatchKey(deltaHandlers, kind)) {
      deltaHandlers[kind](event, delta);
    }
    replay.delta(index, delta);
  };

  const appendToolInput = (event: Readonly<Record<string, unknown>>): void => {
    const index = eventIndex(event);
    const delta = event["delta"];
    if (
      index === undefined ||
      !accumulator.toolCalls.has(index) ||
      !isRecord(delta)
    ) {
      return;
    }
    accumulator.appendToolCallArguments(
      index,
      requiredRecordString(delta, "partial_json", INVALID_DELTA),
    );
  };

  const readCompleteMessage = (
    message: Readonly<Record<string, unknown>>,
  ): void => {
    replay.readModel(message["model"]);
    const content = message["content"];
    if (!Array.isArray(content)) throw new Error(INVALID_MESSAGE);
    for (const [index, value] of content.entries()) {
      if (!isRecord(value)) throw new Error(INVALID_BLOCK);
      readCompleteBlock(index, value);
    }
    readStopReason(message);
    readUsage(message);
    stopped = true;
  };

  const readCompleteBlock = (
    index: number,
    block: Readonly<Record<string, unknown>>,
  ): void => {
    replay.complete(index, block);
    const kind = block["type"];
    if (isDispatchKey(blockHandlers, kind)) {
      blockHandlers[kind](index, block);
    }
  };

  const eventHandlers: Record<
    AnthropicEventKind,
    (event: Readonly<Record<string, unknown>>) => void
  > = {
    content_block_delta: pushDelta,
    content_block_start: startBlock,
    content_block_stop: (event) => {
      replay.stop(eventIndex(event));
    },
    message: readCompleteMessage,
    message_delta: (event) => {
      readStopReason(event["delta"]);
      readOutputTokens(event["usage"]);
    },
    message_start: (event) => {
      readMessageStart(event["message"]);
    },
    message_stop: () => {
      stopped = true;
    },
  };
  const deltaHandlers: Record<
    AnthropicDeltaKind,
    (
      event: Readonly<Record<string, unknown>>,
      delta: Readonly<Record<string, unknown>>,
    ) => void
  > = {
    input_json_delta: appendToolInput,
    text_delta: (_event, delta) => {
      accumulator.pushText(requiredRecordString(delta, "text", INVALID_DELTA));
    },
    thinking_delta: (_event, delta) => {
      accumulator.pushThinking(
        requiredRecordString(delta, "thinking", INVALID_DELTA),
      );
    },
  };
  const blockHandlers: Record<
    AnthropicBlockKind,
    (
      index: number,
      block: Readonly<Record<string, unknown>>,
    ) => void
  > = {
    text: (_index, block) => {
      accumulator.pushText(requiredRecordString(block, "text", INVALID_BLOCK));
    },
    thinking: (_index, block) => {
      accumulator.pushThinking(
        requiredRecordString(block, "thinking", INVALID_BLOCK),
      );
    },
    tool_use: (index, block) => {
      // A parsed JSON body always re-serializes; the whole event came from
      // JSON.parse.
      const input = JSON.stringify(block["input"] ?? {});
      accumulator.registerToolCall(index, toolUseCall(block, input));
    },
  };
  return accumulatorResult({
    completed,
    finish,
    protocol: "anthropic",
    push,
    receivedEvent: accumulator.receivedEvent,
  });
}
