import type {
  AnthropicReplayBlock,
  AnthropicReplayObject,
} from "../../shared/anthropic-replay.ts";
import { AnthropicStreamAccumulator } from "../../sync-engine/provider-stream-anthropic.ts";
import {
  ANTHROPIC_TEST_PROVENANCE,
  anthropicEvents,
  KNOWN_ANTHROPIC_MODEL,
} from "./anthropic-model-test-helpers.ts";

export function anthropicMessageStart(inputTokens = 1, container?: unknown) {
  return {
    message: {
      ...(container === undefined ? {} : { container }),
      usage: { input_tokens: inputTokens },
    },
    type: "message_start",
  };
}

export function anthropicBlockStart(
  index: number,
  contentBlock: Readonly<Record<string, unknown>>,
) {
  return { content_block: contentBlock, index, type: "content_block_start" };
}

export function anthropicBlockDelta(
  index: number,
  delta: Readonly<Record<string, unknown>>,
) {
  return { delta, index, type: "content_block_delta" };
}

export function anthropicBlockStop(index: number) {
  return { index, type: "content_block_stop" };
}

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

export function streamedAnthropicTextBlockEvents(
  index: number,
  text: string,
  stopped = true,
): readonly unknown[] {
  return [
    anthropicBlockStart(index, { text: "", type: "text" }),
    anthropicBlockDelta(index, { text, type: "text_delta" }),
    ...(stopped ? [anthropicBlockStop(index)] : []),
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
  readonly stopReason?: string;
}): Response {
  return Response.json({
    ...(options.container === undefined
      ? {}
      : { container: options.container }),
    content: options.blocks,
    role: "assistant",
    ...(options.stopReason === undefined
      ? {}
      : { stop_reason: options.stopReason }),
    type: "message",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

export function anthropicPauseTurnResponse(
  blocks: readonly Readonly<Record<string, unknown>>[],
  stream: boolean,
  container?: unknown,
): Response {
  if (!stream) {
    return anthropicJsonResponse({
      blocks,
      container,
      stopReason: "pause_turn",
    });
  }
  return anthropicEvents([
    anthropicMessageStart(1, container),
    ...blocks.flatMap((block, index) =>
      block["type"] === "text" && typeof block["text"] === "string"
        ? [
            anthropicBlockStart(index, { ...block, text: "" }),
            anthropicBlockDelta(index, {
              text: block["text"],
              type: "text_delta",
            }),
            anthropicBlockStop(index),
          ]
        : [anthropicBlockStart(index, block), anthropicBlockStop(index)],
    ),
    {
      delta: { stop_reason: "pause_turn" },
      type: "message_delta",
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ]);
}

export function streamedReplayEvents(
  blocks: readonly AnthropicReplayBlock[],
): readonly unknown[] {
  return blocks.flatMap((block, index) => [
    anthropicBlockStart(index, block),
    anthropicBlockStop(index),
  ]);
}

export function finishedAnthropicStep(events: readonly unknown[]) {
  const accumulator = new AnthropicStreamAccumulator(
    KNOWN_ANTHROPIC_MODEL,
    ANTHROPIC_TEST_PROVENANCE,
  );
  for (const event of events) accumulator.push(event);
  return accumulator.finish();
}
