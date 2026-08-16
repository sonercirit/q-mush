import type {
  AnthropicReplayBlock,
  AnthropicReplayObject,
} from "../../shared/anthropic-replay.ts";
import { AnthropicStreamAccumulator } from "../../sync-engine/provider-stream-anthropic.ts";
import {
  ANTHROPIC_TEST_PROVENANCE,
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicEvents,
  anthropicMessageDelta,
  anthropicMessageStart,
  KNOWN_ANTHROPIC_MODEL,
  streamedAnthropicTextBlockEvents,
} from "./anthropic-model-test-helpers.ts";

export function streamedAnthropicToolEvents(options: {
  readonly id: string;
  readonly index: number;
  readonly initialInput?: AnthropicReplayObject;
  readonly name: string;
  readonly partialJson: string;
}): readonly unknown[] {
  return [
    anthropicBlockStart(options.index, {
      id: options.id,
      ...(options.initialInput === undefined
        ? {}
        : { input: options.initialInput }),
      name: options.name,
      type: "tool_use",
    }),
    anthropicBlockDelta(options.index, {
      partial_json: options.partialJson,
      type: "input_json_delta",
    }),
    anthropicBlockStop(options.index),
  ];
}

export function streamedAnthropicReadEvents(
  id: string,
  index: number,
): readonly unknown[] {
  return streamedAnthropicToolEvents({
    id,
    index,
    name: "read",
    partialJson: "{}",
  });
}

export function futureAnthropicBlock(index: number) {
  return [
    anthropicBlockStart(index, {
      encrypted: "future-data",
      type: "future_block",
    }),
    anthropicBlockDelta(index, {
      fragment: "future-delta",
      type: "future_delta",
    }),
    anthropicBlockStop(index),
  ];
}

export function streamedAnthropicTextEvents(text: string): readonly unknown[] {
  return [
    ...streamedAnthropicTextBlockEvents(1, text),
    { type: "message_stop" },
  ];
}

export function stoppedAnthropicEvents(events: readonly unknown[]): Response {
  return anthropicEvents([
    anthropicMessageStart(),
    ...events,
    { type: "message_stop" },
  ]);
}

export function anthropicJsonResponse(options: {
  readonly blocks: readonly Readonly<Record<string, unknown>>[];
  readonly container?: unknown;
  readonly model?: string;
  readonly stopReason?: string;
}): Response {
  return Response.json({
    container: options.container,
    content: options.blocks,
    model: options.model ?? KNOWN_ANTHROPIC_MODEL,
    role: "assistant",
    stop_reason: options.stopReason,
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

export function anthropicReplayResponse(
  blocks: readonly Readonly<Record<string, unknown>>[],
  options: {
    readonly stopReason?: string;
    readonly stream: boolean;
    readonly container?: unknown;
  },
): Response {
  if (!options.stream) {
    return anthropicJsonResponse({
      blocks,
      ...(options.container === undefined
        ? {}
        : { container: options.container }),
      ...(options.stopReason === undefined
        ? {}
        : { stopReason: options.stopReason }),
    });
  }
  return anthropicEvents([
    anthropicMessageStart(1, options.container),
    ...blocks.flatMap((block, index) =>
      block["type"] === "text" && typeof block["text"] === "string"
        ? streamedAnthropicTextBlockEvents(index, block["text"])
        : [anthropicBlockStart(index, block), anthropicBlockStop(index)],
    ),
    ...(options.stopReason === undefined
      ? []
      : [anthropicMessageDelta(options.stopReason, 1)]),
    { type: "message_stop" },
  ]);
}

export function anthropicPauseTurnResponse(
  blocks: readonly Readonly<Record<string, unknown>>[],
  stream: boolean,
  container?: unknown,
): Response {
  return anthropicReplayResponse(blocks, {
    ...(container === undefined ? {} : { container }),
    stopReason: "pause_turn",
    stream,
  });
}

export function streamedReplayEvents(
  blocks: readonly AnthropicReplayBlock[],
): readonly unknown[] {
  return blocks.flatMap((block, index) => [
    anthropicBlockStart(index, block),
    anthropicBlockStop(index),
  ]);
}

export function finishedAnthropicStep(
  events: readonly unknown[],
  model = KNOWN_ANTHROPIC_MODEL,
) {
  const accumulator = new AnthropicStreamAccumulator(
    model,
    ANTHROPIC_TEST_PROVENANCE,
  );
  for (const event of events) accumulator.push(event);
  return accumulator.finish();
}
