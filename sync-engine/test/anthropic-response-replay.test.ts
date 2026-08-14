import { describe, expect, test } from "vitest";
import type { AnthropicReplayObject } from "../../shared/anthropic-replay.ts";
import { AnthropicStreamAccumulator } from "../../sync-engine/provider-stream-anthropic.ts";
import { recordedMessageValues } from "../../sync-engine/session-store-values.ts";
import {
  ANTHROPIC_TEST_PROVENANCE,
  anthropicEvents,
  anthropicHarness,
  doneAnthropicEvents,
  JSON_RESPONSE_REPLAY_BLOCKS,
  KNOWN_ANTHROPIC_MODEL,
  redactedReplayBlock,
  textReplayBlock,
  textStopAnthropicEvents,
  thinkingReplayBlock,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import {
  capturedAssistantContent,
  type AnthropicHarness,
} from "./anthropic-replay-request-helpers.ts";

function messageStart(inputTokens = 1) {
  return {
    message: { usage: { input_tokens: inputTokens } },
    type: "message_start",
  };
}

function blockStart(
  index: number,
  contentBlock: Readonly<Record<string, unknown>>,
) {
  return { content_block: contentBlock, index, type: "content_block_start" };
}

function blockDelta(index: number, delta: Readonly<Record<string, unknown>>) {
  return { delta, index, type: "content_block_delta" };
}

function blockStop(index: number) {
  return { index, type: "content_block_stop" };
}

function streamedToolEvents(options: {
  readonly id: string;
  readonly index: number;
  readonly initialInput?: AnthropicReplayObject;
  readonly name: string;
  readonly partialJson: string;
}): readonly unknown[] {
  return [
    blockStart(options.index, {
      id: options.id,
      ...(options.initialInput === undefined
        ? {}
        : { input: options.initialInput }),
      name: options.name,
      type: "tool_use",
    }),
    blockDelta(options.index, {
      partial_json: options.partialJson,
      type: "input_json_delta",
    }),
    blockStop(options.index),
  ];
}

function streamedReadEvents(id: string, index: number): readonly unknown[] {
  return streamedToolEvents({
    id,
    index,
    name: "read",
    partialJson: "{}",
  });
}

function futureBlock(index: number) {
  return [
    blockStart(index, { encrypted: "future-data", type: "future_block" }),
    blockDelta(index, { fragment: "future-delta", type: "future_delta" }),
    blockStop(index),
  ];
}

function streamedTextEvents(text: string): readonly unknown[] {
  return [
    blockStart(1, { text: "", type: "text" }),
    blockDelta(1, { text, type: "text_delta" }),
    blockStop(1),
    { type: "message_stop" },
  ];
}

function stoppedEvents(events: readonly unknown[]): Response {
  return anthropicEvents([messageStart(), ...events, { type: "message_stop" }]);
}

function finishAccumulator(events: readonly unknown[]) {
  const accumulator = new AnthropicStreamAccumulator(
    KNOWN_ANTHROPIC_MODEL,
    ANTHROPIC_TEST_PROVENANCE,
  );
  for (const event of events) accumulator.push(event);
  return accumulator.finish.bind(accumulator);
}

function thinkingBlockStart(index: number) {
  return blockStart(index, { thinking: "", type: "thinking" });
}

function finishedStep(events: readonly unknown[]) {
  return finishAccumulator(events)();
}

function expectReplayUnavailable(step: unknown): void {
  expect(step).not.toHaveProperty("providerReplay");
}

function noArgumentReplayBlocks(text = "") {
  return [
    thinkingReplayBlock("signed-thinking", "Inspect."),
    ...(text.length === 0 ? [] : [textReplayBlock(text)]),
    toolReplayBlock({ id: "list-call", input: {}, name: "list_runners" }),
  ];
}

function signedNoArgumentToolResponse(text = ""): Response {
  return anthropicEvents([
    messageStart(4),
    thinkingBlockStart(0),
    blockDelta(0, { thinking: "Inspect.", type: "thinking_delta" }),
    blockDelta(0, { signature: "signed-thinking", type: "signature_delta" }),
    blockStop(0),
    blockStart(1, { text: "", type: "text" }),
    ...(text.length === 0 ? [] : [blockDelta(1, { text, type: "text_delta" })]),
    blockStop(1),
    ...streamedToolEvents({
      id: "list-call",
      index: 2,
      initialInput: {},
      name: "list_runners",
      partialJson: "",
    }),
    { type: "message_stop" },
  ]);
}

async function completedNoArgumentTool(text = "") {
  const harness = anthropicHarness([
    signedNoArgumentToolResponse(text),
    doneAnthropicEvents(),
  ]);
  return { harness, step: await harness.complete() };
}

async function replayNoArgumentTool(
  harness: AnthropicHarness,
  step: Awaited<ReturnType<AnthropicHarness["complete"]>>,
): Promise<unknown> {
  const assistant = {
    content: step.content,
    role: "assistant" as const,
    toolCalls: step.toolCalls,
  };
  await harness.complete([
    { content: "List runners", role: "user" },
    step.providerReplay === undefined
      ? assistant
      : { ...assistant, providerReplay: step.providerReplay },
    {
      content: "[]",
      role: "tool",
      toolCallId: "list-call",
      toolName: "list_runners",
    },
  ]);
  return capturedAssistantContent(harness, 1);
}

function partialToolStop(
  stopReason: "max_tokens" | "model_context_window_exceeded",
): Response {
  return anthropicEvents([
    messageStart(3),
    blockStart(0, replayTool()),
    blockDelta(0, { partial_json: '{"path":', type: "input_json_delta" }),
    blockStop(0),
    {
      delta: { stop_reason: stopReason },
      type: "message_delta",
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]);
}

function replayTool(caller?: AnthropicReplayObject): AnthropicReplayObject {
  return {
    ...(caller === undefined ? {} : { caller }),
    id: caller === undefined ? "partial-call" : "call-1",
    name: "read",
    type: "tool_use",
  };
}

describe("Anthropic response replay", () => {
  test("streams ordered thinking, redaction, text, and tool blocks", async () => {
    const deltas: string[] = [];
    const harness = anthropicHarness(
      [
        anthropicEvents([
          messageStart(12),
          thinkingBlockStart(0),
          blockDelta(0, { thinking: "Inspect first.", type: "thinking_delta" }),
          blockDelta(0, { signature: "signed-", type: "signature_delta" }),
          blockDelta(0, { signature: "thinking", type: "signature_delta" }),
          blockStop(0),
          blockStart(1, {
            data: "encrypted-redaction",
            type: "redacted_thinking",
          }),
          blockStop(1),
          blockStart(2, { text: "", type: "text" }),
          blockDelta(2, { text: "Checking.", type: "text_delta" }),
          blockStop(2),
          blockStart(3, { id: "call-9", name: "read", type: "tool_use" }),
          blockDelta(3, {
            partial_json: '{"path":',
            type: "input_json_delta",
          }),
          blockDelta(3, {
            partial_json: '"src"}',
            type: "input_json_delta",
          }),
          blockStop(3),
          { type: "message_delta", usage: { output_tokens: 9 } },
          { type: "message_stop" },
        ]),
      ],
      {
        onDelta: (delta) => {
          deltas.push(delta.thinking);
        },
      },
    );

    const step = await harness.complete([{ content: "Go", role: "user" }]);

    expect(step.thinking).toBe("Inspect first.");
    expect(step.content).toBe("Checking.");
    const expectedReplay = {
      blocks: [
        thinkingReplayBlock("signed-thinking", "Inspect first."),
        redactedReplayBlock("encrypted-redaction"),
        textReplayBlock("Checking."),
        toolReplayBlock({
          id: "call-9",
          input: { path: "src" },
          name: "read",
        }),
      ],
      model: KNOWN_ANTHROPIC_MODEL,
      protocol: "anthropic" as const,
      provenance: ANTHROPIC_TEST_PROVENANCE,
    };
    expect(step.providerReplay).toEqual(expectedReplay);
    const expectedCall = {
      arguments: '{"path":"src"}',
      id: "call-9",
      name: "read",
    };
    expect(step.toolCalls).toEqual([expectedCall]);
    expect(step.tokenUsage).toEqual({
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 12,
      outputTokens: 9,
    });
    expect(deltas.join("")).toBe("Inspect first.");
  });

  test("preserves empty-input signed replay and degrades invalid streams", async () => {
    const { harness, step } = await completedNoArgumentTool("Listing.");

    expect(step).toMatchObject({
      content: "Listing.",
      thinking: "Inspect.",
      toolCalls: [{ arguments: "{}", id: "list-call", name: "list_runners" }],
    });
    expect(step.providerReplay?.blocks).toEqual(
      noArgumentReplayBlocks("Listing."),
    );
    expect(await replayNoArgumentTool(harness, step)).toEqual(
      step.providerReplay?.blocks,
    );

    const unsigned = finishedStep([
      messageStart(),
      thinkingBlockStart(0),
      blockDelta(0, { thinking: "Reasoning", type: "thinking_delta" }),
      blockStop(0),
      ...streamedReadEvents("call-1", 1),
      { type: "message_stop" },
    ]);
    expect(unsigned.thinking).toBe("Reasoning");
    expect(unsigned.toolCalls).toHaveLength(1);
    expect(unsigned.toolCalls[0]).toEqual({
      arguments: "{}",
      id: "call-1",
      name: "read",
    });
    expectReplayUnavailable(unsigned);

    const unknown = await anthropicHarness([
      stoppedEvents([...futureBlock(0), ...streamedTextEvents("Still works.")]),
    ]).complete();
    expect(unknown.content).toBe("Still works.");
    expectReplayUnavailable(unknown);
  });

  test("captures citations while unsafe replay metadata stays optional", async () => {
    const citation = {
      cited_text: "Source text",
      document_index: 0,
      type: "char_location",
    };
    const cited = await anthropicHarness([
      stoppedEvents([
        blockStart(0, { citations: null, text: "", type: "text" }),
        blockDelta(0, { citation, type: "citations_delta" }),
        blockDelta(0, { text: "Cited answer.", type: "text_delta" }),
        blockStop(0),
      ]),
    ]).complete();
    expect(cited.providerReplay?.blocks).toEqual([
      textReplayBlock("Cited answer.", [citation]),
    ]);

    const malformed = finishedStep([
      messageStart(),
      blockStart(0, { type: "text" }),
      blockDelta(0, { text: "Answer", type: "text_delta" }),
      blockDelta(0, { signature: "misplaced", type: "signature_delta" }),
      blockStop(0),
      blockDelta(9, { thinking: "Visible reasoning", type: "thinking_delta" }),
      blockStop(9),
      { type: "message_stop" },
    ]);
    expect(malformed).toMatchObject({
      content: "Answer",
      thinking: "Visible reasoning",
    });
    expectReplayUnavailable(malformed);

    const mixed = finishedStep([
      messageStart(),
      blockStart(0, {
        id: "server-call",
        input: {},
        name: "web_search",
        type: "server_tool_use",
      }),
      blockDelta(0, {
        partial_json: '{"query":"news"}',
        type: "input_json_delta",
      }),
      blockStop(0),
      ...streamedReadEvents("read-call", 1),
      { type: "message_stop" },
    ]);
    expect(mixed.toolCalls).toEqual([
      { arguments: "{}", id: "read-call", name: "read" },
    ]);
    expectReplayUnavailable(mixed);
  });

  test("keeps JSON output without a signature and unfinished streamed output", async () => {
    const jsonStep = await anthropicHarness([
      Response.json({
        content: [
          { signature: null, thinking: "Reasoning", type: "thinking" },
          { text: "Answer", type: "text" },
          toolReplayBlock({
            id: "call-1",
            input: { path: "README.md" },
            name: "read",
          }),
        ],
        type: "message",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]).complete();
    expect(jsonStep.toolCalls).toHaveLength(1);
    expect(jsonStep).toMatchObject({
      content: "Answer",
      thinking: "Reasoning",
    });
    expect(jsonStep.toolCalls[0]).toEqual({
      arguments: '{"path":"README.md"}',
      id: "call-1",
      name: "read",
    });
    expectReplayUnavailable(jsonStep);

    const unfinished = finishedStep([
      messageStart(),
      blockStart(0, { text: "", type: "text" }),
      blockDelta(0, { text: "Incomplete", type: "text_delta" }),
      { type: "message_stop" },
    ]);
    expect(unfinished.content).toBe("Incomplete");
    expectReplayUnavailable(unfinished);
  });

  test("filters empty text and invalid replay without losing persistence", async () => {
    const { harness, step } = await completedNoArgumentTool();
    expect(step.providerReplay?.blocks).toEqual(noArgumentReplayBlocks());
    expect(
      JSON.stringify(await replayNoArgumentTool(harness, step)),
    ).not.toContain('"text":""');

    expect(() =>
      recordedMessageValues({
        content: "Answer",
        providerReplay: {
          blocks: [{ id: "call-1", input: {}, name: "", type: "tool_use" }],
          model: KNOWN_ANTHROPIC_MODEL,
          protocol: "anthropic",
          provenance: ANTHROPIC_TEST_PROVENANCE,
        },
        role: "assistant",
        toolCalls: [],
      }),
    ).not.toThrow();
  });

  test.each(["max_tokens", "model_context_window_exceeded"] as const)(
    "keeps a %s stop with partial tool JSON soft",
    async (stopReason) => {
      const harness = anthropicHarness([partialToolStop(stopReason)]);

      const step = await harness.complete();
      expect(step).toMatchObject({
        toolCalls: [{ arguments: "{}", id: "partial-call", name: "read" }],
        truncation: stopReason,
      });
      expectReplayUnavailable(step);
    },
  );

  test("projects supported streamed fields and preserves tool caller", async () => {
    const harness = anthropicHarness([
      stoppedEvents([
        blockStart(0, {
          future_text_field: "ignored",
          text: "",
          type: "text",
        }),
        blockDelta(0, { text: "Ready.", type: "text_delta" }),
        blockStop(0),
        blockStart(1, {
          ...replayTool({ type: "direct" }),
          future_tool_field: "ignored",
        }),
        blockDelta(1, {
          partial_json: '{"path":"README.md"}',
          type: "input_json_delta",
        }),
        blockStop(1),
      ]),
    ]);

    const step = await harness.complete();
    expect(step.providerReplay?.blocks).toEqual([
      { text: "Ready.", type: "text" },
      {
        caller: { type: "direct" },
        id: "call-1",
        input: { path: "README.md" },
        name: "read",
        type: "tool_use",
      },
    ]);
  });

  for (const stopReason of [
    "max_tokens",
    "model_context_window_exceeded",
  ] as const) {
    test(`reports ${stopReason} stops as truncation`, async () => {
      const harness = anthropicHarness([
        textStopAnthropicEvents({
          stopReason,
          text: "Partial",
          usage: { input_tokens: 3 },
        }),
      ]);

      const step = await harness.complete();

      expect(step.content).toBe("Partial");
      expect(step.truncation).toBe(stopReason);
    });
  }

  async function completedTruncation(
    response: Response,
  ): Promise<string | undefined> {
    const step = await anthropicHarness([response]).complete();
    return step.truncation;
  }

  test("reports no truncation for an end_turn stop", async () => {
    const truncation = await completedTruncation(doneAnthropicEvents());
    expect(truncation).toBeUndefined();
  });

  test("reports truncation from a non-streaming stopped message", async () => {
    const stopped = Response.json({
      content: [{ text: "Cut short.", type: "text" }],
      role: "assistant",
      stop_reason: "max_tokens",
      type: "message",
      usage: { input_tokens: 4, output_tokens: 2 },
    });

    expect(await completedTruncation(stopped)).toBe("max_tokens");
  });

  test("parses omitted thinking and redaction from a JSON response", async () => {
    const harness = anthropicHarness([
      Response.json({
        content: JSON_RESPONSE_REPLAY_BLOCKS,
        role: "assistant",
        type: "message",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    ]);

    const step = await harness.complete([{ content: "Hi", role: "user" }]);

    expect(step.content).toBe("Plain.");
    expect(step.thinking).toBe("");
    expect(step.providerReplay).toEqual({
      blocks: JSON_RESPONSE_REPLAY_BLOCKS,
      model: KNOWN_ANTHROPIC_MODEL,
      protocol: "anthropic",
      provenance: ANTHROPIC_TEST_PROVENANCE,
    });
    const call = {
      arguments: '{"command":"ls"}',
      id: "call-2",
      name: "bash",
    };
    expect(step.toolCalls).toEqual([call]);
    expect(step.tokenUsage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });
});
