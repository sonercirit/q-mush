import { describe, expect, test } from "vitest";
import {
  parseAnthropicAssistantReplay,
  serializeAnthropicAssistantReplay,
  type AnthropicReplayBlock,
  type AnthropicReplayObject,
} from "../../shared/anthropic-replay.ts";
import { recordedMessageValues } from "../../sync-engine/session-store-values.ts";
import {
  ANTHROPIC_TEST_PROVENANCE,
  anthropicBlockDelta,
  anthropicBlockStart,
  anthropicBlockStop,
  anthropicEvents,
  anthropicHarness,
  anthropicMessageStart,
  doneAnthropicEvents,
  JSON_RESPONSE_REPLAY_BLOCKS,
  KNOWN_ANTHROPIC_MODEL,
  redactedReplayBlock,
  serverToolReplayBlock,
  streamedAnthropicTextBlockEvents,
  textReplayBlock,
  textStopAnthropicEvents,
  thinkingReplayBlock,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import {
  capturedReplayRequest,
  type AnthropicHarness,
} from "./anthropic-replay-request-helpers.ts";
import {
  anthropicJsonResponse,
  finishedAnthropicStep,
  futureAnthropicBlock,
  stoppedAnthropicEvents,
  streamedAnthropicReadEvents,
  streamedAnthropicTextEvents,
  streamedAnthropicToolEvents,
  streamedReplayEvents,
} from "./anthropic-response-event-fixtures.ts";
import { emptyProviderToolCall } from "./provider-step-fixtures.ts";

const ADDITIVE_TOOL_BLOCK = {
  caller: { type: "direct" },
  future_tool_field: { token: "opaque" },
  id: "call-additive",
  input: { path: "additive-provider-field.md" },
  name: "read_additive_field",
  type: "tool_use" as const,
};

function additiveReplayBlocks() {
  return [
    {
      signature: "signed-thinking",
      thinking: "Inspect.",
      type: "thinking" as const,
      vendor_metadata: { revision: 2 },
    },
    {
      future_text_field: ["opaque", { enabled: true }],
      text: "Ready.",
      type: "text" as const,
    },
    ADDITIVE_TOOL_BLOCK,
  ] as const;
}

function streamedToolDelta(
  index: number,
  input: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  return [
    anthropicBlockDelta(index, {
      partial_json: JSON.stringify(input),
      type: "input_json_delta",
    }),
    anthropicBlockStop(index),
  ];
}

function thinkingBlockStart(index: number) {
  return anthropicBlockStart(index, { thinking: "", type: "thinking" });
}

function streamedTextStep(
  text: string,
  options: { readonly stopped: boolean },
) {
  return finishedAnthropicStep([
    anthropicMessageStart(),
    ...streamedAnthropicTextBlockEvents(0, text, options.stopped),
    { type: "message_stop" },
  ]);
}

function expectReplayUnavailable(step: unknown): void {
  expect(step).not.toHaveProperty("providerReplay");
}

test.each<AnthropicReplayBlock>([
  { text: "", type: "text" },
  { citations: "invalid", text: "Answer", type: "text" },
  {
    caller: "invalid",
    id: "call-1",
    input: {},
    name: "read",
    type: "tool_use",
  },
  {
    caller: "invalid",
    id: "server-call-1",
    input: {},
    name: "web_search",
    type: "server_tool_use",
  },
  {
    caller: "invalid",
    content: [],
    tool_use_id: "server-call-1",
    type: "web_search_tool_result",
  },
])(
  "rejects malformed optional replay fields in $type blocks",
  (block: AnthropicReplayBlock) => {
    const replay = {
      blocks: [block],
      model: KNOWN_ANTHROPIC_MODEL,
      protocol: "anthropic" as const,
      provenance: ANTHROPIC_TEST_PROVENANCE,
    };
    const serialized = JSON.stringify(replay);

    expect(serializeAnthropicAssistantReplay(replay)).toBeNull();
    expect(() => parseAnthropicAssistantReplay(serialized)).toThrow(
      "Anthropic assistant replay data is invalid",
    );
  },
);

test("rejects an invalid replay container", () => {
  const malformedReplay = {
    blocks: [{ text: "Done.", type: "text" }] as const,
    container: "",
    model: KNOWN_ANTHROPIC_MODEL,
    protocol: "anthropic" as const,
    provenance: ANTHROPIC_TEST_PROVENANCE,
  };
  expect(serializeAnthropicAssistantReplay(malformedReplay)).toBeNull();
  expect(() =>
    parseAnthropicAssistantReplay(JSON.stringify(malformedReplay)),
  ).toThrow("Anthropic assistant replay data is invalid");
});

function noArgumentReplayBlocks(text = "") {
  return [
    thinkingReplayBlock("signed-thinking", "Inspect."),
    ...(text.length === 0 ? [] : [textReplayBlock(text)]),
    toolReplayBlock({ id: "list-call", input: {}, name: "list_runners" }),
  ];
}

function signedNoArgumentToolResponse(text = ""): Response {
  return anthropicEvents([
    anthropicMessageStart(4),
    thinkingBlockStart(0),
    anthropicBlockDelta(0, { thinking: "Inspect.", type: "thinking_delta" }),
    anthropicBlockDelta(0, {
      signature: "signed-thinking",
      type: "signature_delta",
    }),
    anthropicBlockStop(0),
    anthropicBlockStart(1, { text: "", type: "text" }),
    ...(text.length === 0
      ? []
      : [anthropicBlockDelta(1, { text, type: "text_delta" })]),
    anthropicBlockStop(1),
    ...streamedAnthropicToolEvents({
      id: "list-call",
      index: 2,
      initialInput: {},
      name: "list_runners",
      partialJson: "",
    }),
    { type: "message_stop" },
  ]);
}

function replayListRunners(
  harness: AnthropicHarness,
  step: Awaited<ReturnType<AnthropicHarness["complete"]>>,
): Promise<unknown> {
  return capturedReplayRequest(harness, step, {
    content: "[]",
    role: "tool",
    toolCallId: "list-call",
    toolName: "list_runners",
  });
}

async function completedNoArgumentTool(text = "") {
  const harness = anthropicHarness([
    signedNoArgumentToolResponse(text),
    doneAnthropicEvents(),
  ]);
  return { harness, step: await harness.complete() };
}

function partialToolStop(
  stopReason: "max_tokens" | "model_context_window_exceeded",
): Response {
  return anthropicEvents([
    anthropicMessageStart(3),
    anthropicBlockStart(0, replayTool()),
    anthropicBlockDelta(0, {
      partial_json: '{"path":',
      type: "input_json_delta",
    }),
    anthropicBlockStop(0),
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
          anthropicMessageStart(12),
          thinkingBlockStart(0),
          anthropicBlockDelta(0, {
            thinking: "Inspect first.",
            type: "thinking_delta",
          }),
          anthropicBlockDelta(0, {
            signature: "signed-",
            type: "signature_delta",
          }),
          anthropicBlockDelta(0, {
            signature: "thinking",
            type: "signature_delta",
          }),
          anthropicBlockStop(0),
          anthropicBlockStart(1, {
            data: "encrypted-redaction",
            type: "redacted_thinking",
          }),
          anthropicBlockStop(1),
          anthropicBlockStart(2, { text: "", type: "text" }),
          anthropicBlockDelta(2, { text: "Checking.", type: "text_delta" }),
          anthropicBlockStop(2),
          anthropicBlockStart(3, {
            id: "call-9",
            name: "read",
            type: "tool_use",
          }),
          anthropicBlockDelta(3, {
            partial_json: '{"path":',
            type: "input_json_delta",
          }),
          anthropicBlockDelta(3, {
            partial_json: '"src"}',
            type: "input_json_delta",
          }),
          anthropicBlockStop(3),
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
    expect(await replayListRunners(harness, step)).toEqual(
      step.providerReplay?.blocks,
    );

    const unsigned = finishedAnthropicStep([
      anthropicMessageStart(),
      thinkingBlockStart(0),
      anthropicBlockDelta(0, { thinking: "Reasoning", type: "thinking_delta" }),
      anthropicBlockStop(0),
      ...streamedAnthropicReadEvents("call-1", 1),
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
      stoppedAnthropicEvents([
        ...futureAnthropicBlock(0),
        ...streamedAnthropicTextEvents("Still works."),
      ]),
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
      stoppedAnthropicEvents([
        anthropicBlockStart(0, { citations: null, text: "", type: "text" }),
        anthropicBlockDelta(0, { citation, type: "citations_delta" }),
        anthropicBlockDelta(0, { text: "Cited answer.", type: "text_delta" }),
        anthropicBlockStop(0),
      ]),
    ]).complete();
    expect(cited.providerReplay?.blocks).toEqual([
      textReplayBlock("Cited answer.", [citation]),
    ]);

    const malformed = finishedAnthropicStep([
      anthropicMessageStart(),
      anthropicBlockStart(0, { type: "text" }),
      anthropicBlockDelta(0, { text: "Answer", type: "text_delta" }),
      anthropicBlockDelta(0, {
        signature: "misplaced",
        type: "signature_delta",
      }),
      anthropicBlockStop(0),
      anthropicBlockDelta(9, {
        thinking: "Visible reasoning",
        type: "thinking_delta",
      }),
      anthropicBlockStop(9),
      { type: "message_stop" },
    ]);
    expect(malformed).toMatchObject({
      content: "Answer",
      thinking: "Visible reasoning",
    });
    expectReplayUnavailable(malformed);

    const mixed = finishedAnthropicStep([
      anthropicMessageStart(),
      anthropicBlockStart(0, {
        id: "server-call",
        input: {},
        name: "web_search",
        type: "server_tool_use",
      }),
      anthropicBlockDelta(0, {
        partial_json: '{"query":"news"}',
        type: "input_json_delta",
      }),
      anthropicBlockStop(0),
      ...streamedAnthropicReadEvents("read-call", 1),
      { type: "message_stop" },
    ]);
    expect(mixed.toolCalls).toEqual([
      emptyProviderToolCall("read-call", "read"),
    ]);
    expect(mixed.providerReplay?.blocks).toEqual([
      serverToolReplayBlock({
        id: "server-call",
        input: { query: "news" },
        name: "web_search",
      }),
      toolReplayBlock({ id: "read-call", input: {}, name: "read" }),
    ]);
  });

  test("captures streamed server results, uploads, and callers unchanged", () => {
    const caller = { tool_id: "code-call", type: "code_execution_20260120" };
    const blocks = [
      {
        caller,
        content: [{ encrypted_content: "opaque", type: "web_search_result" }],
        tool_use_id: "search-call",
        type: "web_search_tool_result",
      },
      { file_id: "file-1", type: "container_upload" },
    ] as const;
    const events = [
      anthropicMessageStart(),
      ...streamedReplayEvents(blocks),
      { type: "message_stop" },
    ];

    expect(finishedAnthropicStep(events).providerReplay?.blocks).toEqual(
      blocks,
    );
  });

  test("keeps JSON output without a signature and unfinished streamed output", async () => {
    const jsonStep = await anthropicHarness([
      anthropicJsonResponse({
        blocks: [
          { signature: null, thinking: "Reasoning", type: "thinking" },
          { text: "Answer", type: "text" },
          toolReplayBlock({
            id: "call-1",
            input: { path: "README.md" },
            name: "read",
          }),
        ],
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

    const unfinished = streamedTextStep("Incomplete", { stopped: false });
    expect(unfinished.content).toBe("Incomplete");
    expectReplayUnavailable(unfinished);
  });

  test("filters empty text and invalid replay without losing persistence", async () => {
    const { harness, step } = await completedNoArgumentTool();
    expect(step.providerReplay?.blocks).toEqual(noArgumentReplayBlocks());
    expect(
      JSON.stringify(await replayListRunners(harness, step)),
    ).not.toContain('"text":""');

    // Whitespace-only text is real assistant content: dropping it from the
    // replay would make it stop matching the persisted message.
    const whitespace = streamedTextStep("   ", { stopped: true });
    expect(whitespace.content).toBe("   ");
    expect(whitespace.providerReplay?.blocks).toEqual([textReplayBlock("   ")]);

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

  test("preserves additive JSON-safe provider fields exactly", async () => {
    const expected = additiveReplayBlocks();
    const [additiveThinking, additiveText, additiveTool] = expected;

    const json = await anthropicHarness([
      anthropicJsonResponse({
        blocks: [additiveThinking, additiveText, additiveTool],
      }),
    ]).complete();
    const streamed = await anthropicHarness([
      stoppedAnthropicEvents([
        anthropicBlockStart(0, additiveThinking),
        anthropicBlockStop(0),
        anthropicBlockStart(1, {
          ...additiveText,
          text: "",
        }),
        anthropicBlockDelta(1, { text: "Ready.", type: "text_delta" }),
        anthropicBlockStop(1),
        anthropicBlockStart(2, {
          ...additiveTool,
          input: {},
        }),
        ...streamedToolDelta(2, additiveTool.input),
      ]),
    ]).complete();

    expect(json.providerReplay?.blocks).toEqual(expected);
    expect(streamed.providerReplay?.blocks).toEqual(expected);
    const serialized = serializeAnthropicAssistantReplay(json.providerReplay);
    expect(parseAnthropicAssistantReplay(serialized)).toEqual(
      json.providerReplay,
    );
  });

  test("captures supported streamed fields and preserves tool caller", async () => {
    const [, additiveText, additiveTool] = additiveReplayBlocks();
    const harness = anthropicHarness([
      stoppedAnthropicEvents([
        anthropicBlockStart(0, { ...additiveText, text: "" }),
        anthropicBlockDelta(0, { text: additiveText.text, type: "text_delta" }),
        anthropicBlockStop(0),
        anthropicBlockStart(1, { ...additiveTool, input: {} }),
        ...streamedToolDelta(1, additiveTool.input),
      ]),
    ]);

    const step = await harness.complete();
    expect(step.providerReplay?.blocks).toEqual([additiveText, additiveTool]);
  });

  for (const stopReason of [
    "max_tokens",
    "model_context_window_exceeded",
  ] as const) {
    test(`reports ${stopReason} stops as truncation`, async () => {
      const step = await anthropicHarness([
        textStopAnthropicEvents({
          stopReason,
          text: "Partial",
          usage: { input_tokens: 3 },
        }),
      ]).complete();

      expect(step).toMatchObject({
        content: "Partial",
        truncation: stopReason,
      });
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
      model: KNOWN_ANTHROPIC_MODEL,
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
        model: KNOWN_ANTHROPIC_MODEL,
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
