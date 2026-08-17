import { describe, expect, test } from "vitest";
import type { AnthropicReplayObject } from "../../shared/anthropic-replay.ts";
import type { ProviderTextDelta } from "../provider-stream.ts";
import {
  anthropicEvents,
  anthropicHarness,
  anthropicHarnessWithFollowUp,
  anthropicMessageStart,
  doneAnthropicEvents,
  serverToolReplayBlock,
  streamedAnthropicTextBlockEvents,
  toolReplayBlock,
} from "./anthropic-model-test-helpers.ts";
import {
  anthropicJsonResponse,
  anthropicPauseTurnResponse,
} from "./anthropic-response-event-fixtures.ts";
import { emptyProviderToolCall } from "./provider-step-fixtures.ts";

const PAUSE_ERROR =
  "The Anthropic response paused with content that cannot be continued safely";
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

async function expectPauseRejected(
  harness: ReturnType<typeof anthropicHarness>,
): Promise<void> {
  await expect(harness.complete()).rejects.toThrow(PAUSE_ERROR);
  expect(harness.requests).toHaveLength(1);
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

function continuationBody(
  content: readonly unknown[],
  container = "container-1",
) {
  return {
    container,
    messages: [{ role: "user" }, { content, role: "assistant" }],
  };
}

type PauseContinuationCase = Readonly<{
  blocks: readonly Readonly<Record<string, unknown>>[];
  container?: unknown;
  stream: boolean;
}>;

async function replayedRequestBody(
  options: PauseContinuationCase,
): Promise<unknown> {
  const harness = anthropicHarness([
    anthropicPauseTurnResponse(
      options.blocks,
      options.stream,
      options.container,
    ),
    doneAnthropicEvents(),
  ]);
  await harness.complete();
  return harness.requestBody(1);
}

describe("Anthropic pause_turn", () => {
  test.each([true, false])(
    "continues a %s-streamed pause_turn with the assistant blocks unchanged",
    async function continuesPausedTurn(stream) {
      const serverToolCall = serverCall("web_search", { query: "news" });
      const harness = anthropicHarnessWithFollowUp(
        anthropicPauseTurnResponse([PAUSED_TEXT, serverToolCall], stream),
      );

      const step = await harness.complete();
      expect(harness.requests.length).toBe(2);

      expect(step.content).toBe("Searching. Done.");
      expectCombinedUsage(step);
      const body = await harness.requestBody(1);
      expect(body).toMatchObject({
        messages: [
          { role: "user" },
          {
            content: [{ text: "Searching.", type: "text" }, serverToolCall],
            role: "assistant",
          },
        ],
      });
      expect(PAUSED_TEXT.text).toBe("Searching. ");
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

    await expectPauseRejected(harness);
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
      const body = await replayedRequestBody({
        blocks: [serverToolCall],
        container,
        stream,
      });

      expect(body).toMatchObject(continuationBody([serverToolCall]));
    },
  );

  test.each([true, false])(
    "trims every trailing text block beside signed thinking, server tools, and a %s-streamed container",
    async (stream) => {
      const thinking = {
        signature: "signed-thinking",
        thinking: "Inspect.",
        type: "thinking" as const,
      };
      const answer = { text: "Answer. ", type: "text" as const };
      const serverToolCall = serverCall("code_execution", {
        code: "print('hi')",
      });
      const whitespace = { text: "  ", type: "text" as const };
      const tab = { text: "\t", type: "text" as const };
      const body = await replayedRequestBody({
        blocks: [thinking, answer, serverToolCall, whitespace, tab],
        container: { id: "container-1" },
        stream,
      });

      expect(body).toMatchObject(
        continuationBody([
          thinking,
          { text: "Answer.", type: "text" },
          serverToolCall,
        ]),
      );
    },
  );

  test.each([true, false])(
    "fails a %s-streamed whitespace-only pause before sending a user-only follow-up",
    async (stream) => {
      const harness = anthropicHarness([
        anthropicPauseTurnResponse([{ text: "   ", type: "text" }], stream),
        doneAnthropicEvents(),
      ]);

      await expectPauseRejected(harness);
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
