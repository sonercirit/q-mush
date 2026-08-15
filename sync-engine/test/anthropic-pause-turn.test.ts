import { describe, expect, test } from "vitest";
import type { AnthropicReplayObject } from "../../shared/anthropic-replay.ts";
import type { ProviderTextDelta } from "../provider-stream.ts";
import {
  anthropicEvents,
  anthropicHarness,
  doneAnthropicEvents,
  serverToolReplayBlock,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import {
  anthropicJsonResponse,
  anthropicMessageStart,
  anthropicPauseTurnResponse,
  streamedAnthropicTextBlockEvents,
} from "./anthropic-response-event-fixtures.ts";
import { emptyProviderToolCall } from "./provider-step-fixtures.ts";

const PAUSED_TEXT = { text: "Searching. ", type: "text" } as const;
const PAUSED_DELTA = { content: PAUSED_TEXT.text, thinking: "" } as const;
const RESET_DELTA = { content: "", reset: true, thinking: "" } as const;
const DONE_DELTA = { content: "Done.", thinking: "" } as const;

function captureDeltas() {
  const deltas: ProviderTextDelta[] = [];
  return {
    deltas,
    onDelta: (delta: ProviderTextDelta) => {
      deltas.push(delta);
    },
  };
}

function expectedContinuationDeltas(
  continuation: readonly ProviderTextDelta[],
): readonly ProviderTextDelta[] {
  return [PAUSED_DELTA, RESET_DELTA, PAUSED_DELTA, ...continuation];
}

function serverCall(name: string, input: AnthropicReplayObject) {
  return serverToolReplayBlock({ id: "srvtoolu_1", input, name });
}

function expectCombinedUsage(
  step: Awaited<ReturnType<ReturnType<typeof anthropicHarness>["complete"]>>,
): void {
  expect(step.tokenUsage).toEqual({
    cacheWriteInputTokens: 40,
    cachedInputTokens: 900,
    inputTokens: 1_001,
    outputTokens: 6,
  });
}

describe("Anthropic pause_turn", () => {
  test.each([true, false])(
    "continues a %s-streamed pause_turn with the assistant blocks unchanged",
    async function continuesPausedTurn(stream) {
      const serverToolCall = serverCall("web_search", { query: "news" });
      const harness = anthropicHarness([
        anthropicPauseTurnResponse([PAUSED_TEXT, serverToolCall], stream),
        doneAnthropicEvents(),
      ]);

      const step = await harness.complete();
      expect(harness.requests.length).toBe(2);

      expect(step.content).toBe("Searching. Done.");
      expectCombinedUsage(step);
      const body = await harness.requestBody(1);
      expect(body).toMatchObject({
        messages: [
          { role: "user" },
          { content: [PAUSED_TEXT, serverToolCall], role: "assistant" },
        ],
      });
    },
  );

  test("fails explicitly when pause_turn replay is unavailable", async () => {
    const harness = anthropicHarness([
      anthropicJsonResponse({
        blocks: [{ text: "Paused", type: "text" }],
        container: "invalid",
        stopReason: "pause_turn",
      }),
    ]);

    await expect(harness.complete()).rejects.toThrow(
      "The Anthropic response paused with content that cannot be continued safely",
    );
    expect(harness.requests).toHaveLength(1);
  });

  test("keeps paused output visible once while continuing", async () => {
    const capture = captureDeltas();
    const harness = anthropicHarness(
      [anthropicPauseTurnResponse([PAUSED_TEXT], true), doneAnthropicEvents()],
      { onDelta: capture.onDelta },
    );

    await harness.complete();

    expect(capture.deltas).toEqual(expectedContinuationDeltas([DONE_DELTA]));
  });

  test("restores paused output when a continuation request retries", async () => {
    const capture = captureDeltas();
    const interrupted = anthropicEvents([
      anthropicMessageStart(),
      ...streamedAnthropicTextBlockEvents(0, "Discarded.", false),
    ]);
    const harness = anthropicHarness(
      [
        anthropicPauseTurnResponse([PAUSED_TEXT], true),
        interrupted,
        doneAnthropicEvents(),
      ],
      { onDelta: capture.onDelta, sleep: () => Promise.resolve() },
    );

    const { content } = await harness.complete();

    expect(content).toBe("Searching. Done.");
    expect(capture.deltas).toEqual(
      expectedContinuationDeltas([
        { content: "Discarded.", thinking: "" },
        RESET_DELTA,
        PAUSED_DELTA,
        DONE_DELTA,
      ]),
    );
  });

  test.each([true, false])(
    "carries a code-execution container through a %s-streamed continuation",
    async (stream) => {
      const serverToolCall = serverCall("code_execution", {
        code: "print('hi')",
      });
      const container = {
        expires_at: "2099-01-01T00:00:00Z",
        id: "container-1",
      };
      const harness = anthropicHarness([
        anthropicPauseTurnResponse([serverToolCall], stream, container),
        doneAnthropicEvents(),
      ]);

      await harness.complete();

      await expect(harness.requestBody(1)).resolves.toMatchObject({
        container: "container-1",
        messages: [
          { role: "user" },
          { content: [serverToolCall], role: "assistant" },
        ],
      });
    },
  );

  test("preserves unresolved server blocks beside client tool calls", async () => {
    const serverToolCall = serverCall("web_fetch", {
      url: "https://example.com",
    });
    const clientCall = toolReplayBlock({
      id: "call-1",
      input: {},
      name: "read",
    });
    const step = await anthropicHarness([
      anthropicJsonResponse({
        blocks: [serverToolCall, clientCall],
        stopReason: "tool_use",
      }),
    ]).complete();

    expect(step.toolCalls).toEqual([emptyProviderToolCall("call-1", "read")]);
    expect(step.providerReplay?.blocks).toEqual([serverToolCall, clientCall]);
  });
});
