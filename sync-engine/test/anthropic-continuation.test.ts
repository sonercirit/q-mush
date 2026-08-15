import { expect, test, vi } from "vitest";
import type {
  AgentConversationMessage,
  AgentModelStep,
  AgentTokenUsage,
} from "../../shared/agent-loop.ts";
import {
  createAnthropicAssistantReplay,
  type AnthropicAssistantReplay,
  type AnthropicReplayBlock,
} from "../../shared/anthropic-replay.ts";
import { completeAnthropicPauseTurns } from "../../sync-engine/anthropic-continuation.ts";
import { toolReplayBlock } from "./anthropic-model-test-helpers.ts";
import {
  emptyProviderToolCall,
  providerStep,
} from "./provider-step-fixtures.ts";

const MODEL = "claude-test";
const PROVENANCE = "test-provenance";
const INITIAL_MESSAGES: readonly AgentConversationMessage[] = [
  { content: "Search", role: "user" },
];

function replay(
  blocks: readonly AnthropicReplayBlock[],
  options: { readonly container?: string; readonly model?: string } = {},
): AnthropicAssistantReplay {
  return createAnthropicAssistantReplay(
    blocks,
    { model: options.model ?? MODEL, provenance: PROVENANCE },
    options.container,
  );
}

function usage(value: number): AgentTokenUsage {
  return {
    cacheWriteInputTokens: value,
    cachedInputTokens: value * 2,
    inputTokens: value * 3,
    outputTokens: value * 4,
  };
}

function stepWithContinuation(
  content: string,
  options: Partial<AgentModelStep>,
): AgentModelStep {
  return providerStep(content, {
    providerReplay: replay([{ text: content, type: "text" }]),
    ...options,
  });
}

function textStep(content: string, options?: Partial<AgentModelStep>) {
  return stepWithContinuation(content, options ?? {});
}

function resolvedTextStep(
  content: string,
  options?: Partial<AgentModelStep>,
): Promise<AgentModelStep> {
  return Promise.resolve(textStep(content, options));
}

function replayToolStep(
  content: string,
  callId: string,
  options?: Partial<AgentModelStep>,
): AgentModelStep {
  const call = emptyProviderToolCall(callId, "read");
  return textStep(content, {
    providerReplay: replay([
      { text: content, type: "text" },
      toolReplayBlock({ id: call.id, input: {}, name: call.name }),
    ]),
    toolCalls: [call],
    ...options,
  });
}

function pausedTextStep(content: string, options?: Partial<AgentModelStep>) {
  return stepWithContinuation(content, {
    ...(options ?? {}),
    providerContinuation: "anthropic_pause_turn",
  });
}

const PAUSE_ERROR =
  "The Anthropic response paused with content that cannot be continued safely";

async function expectPauseFailure(
  step: AgentModelStep,
  complete: Parameters<typeof completeAnthropicPauseTurns>[2],
): Promise<void> {
  await expect(
    completeAnthropicPauseTurns(INITIAL_MESSAGES, step, complete),
  ).rejects.toThrow(PAUSE_ERROR);
}

test("combines repeated pause turns into one exact assistant step", async () => {
  const first = pausedTextStep("First. ", {
    contextTokens: 10,
    costUsd: 0.1,
    providerReplay: replay([{ text: "First. ", type: "text" }], {
      container: "container-1",
    }),
    thinking: "Think one. ",
    tokenUsage: usage(1),
  });
  const second = pausedTextStep("Second. ", {
    contextTokens: 20,
    costUsd: 0.2,
    providerReplay: replay([{ text: "Second. ", type: "text" }], {
      container: "container-1",
    }),
    thinking: "Think two. ",
    tokenUsage: usage(2),
  });
  const final = textStep("Done.", {
    contextTokens: 30,
    costUsd: 0.3,
    providerReplay: replay([{ text: "Done.", type: "text" }], {
      container: "container-1",
    }),
    thinking: "Think three.",
    tokenUsage: usage(3),
  });
  const complete = vi
    .fn<
      (
        messages: readonly AgentConversationMessage[],
        output: { readonly content: string; readonly thinking: string },
      ) => Promise<AgentModelStep>
    >()
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(final);

  const combined = await completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    first,
    complete,
  );

  expect(combined).toMatchObject({
    content: "First. Second. Done.",
    contextTokens: 30,
    providerReplay: replay(
      [
        { text: "First. ", type: "text" },
        { text: "Second. ", type: "text" },
        { text: "Done.", type: "text" },
      ],
      { container: "container-1" },
    ),
    thinking: "Think one. Think two. Think three.",
    tokenUsage: usage(6),
    toolCalls: [],
  });
  expect(combined.costUsd).toBeCloseTo(0.6);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[0]?.[1]).toEqual({
    content: "First. ",
    thinking: "Think one. ",
  });
  expect(complete.mock.calls[1]?.[0]).toEqual([
    ...INITIAL_MESSAGES,
    {
      content: "First. ",
      providerReplay: first.providerReplay,
      role: "assistant",
      toolCalls: [],
    },
    {
      content: "Second. ",
      providerReplay: second.providerReplay,
      role: "assistant",
      toolCalls: [],
    },
  ]);
  expect(complete.mock.calls[1]?.[1]).toEqual({
    content: "First. Second. ",
    thinking: "Think one. Think two. ",
  });
});

test("does not report partial continuation usage or cost as complete", async () => {
  const combined = await completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    pausedTextStep("Partial.", {
      costUsd: 0.1,
      tokenUsage: usage(1),
    }),
    () =>
      Promise.resolve(
        textStep("Done.", {
          costUsd: null,
          tokenUsage: null,
        }),
      ),
  );

  expect(combined).toMatchObject({ costUsd: null, tokenUsage: null });
});

test("rejects unsafe paused responses before requesting a continuation", async function rejectsUnsafePause() {
  const complete = vi.fn(() => Promise.resolve(textStep("unused")));
  const initialPause = replayToolStep("Tool", "call-1", {
    providerContinuation: "anthropic_pause_turn",
  });
  const invalidSteps = [
    providerStep("Missing replay", {
      providerContinuation: "anthropic_pause_turn",
    }),
    pausedTextStep("Mismatch", {
      providerReplay: replay([{ text: "Different", type: "text" }]),
    }),
    initialPause,
    pausedTextStep("Truncated", { truncation: "max_tokens" }),
  ];

  for (const step of invalidSteps) {
    await expectPauseFailure(step, complete);
  }
  expect(complete).not.toHaveBeenCalled();

  const intermediatePause = replayToolStep("Again.", "call-2", {
    providerContinuation: "anthropic_pause_turn",
  });
  await expectPauseFailure(pausedTextStep("First."), () =>
    Promise.resolve(intermediatePause),
  );
});

test("rejects a changed replay identity or container during continuation", async () => {
  const changedIdentity = completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    pausedTextStep("First."),
    () => {
      const changedReplay = replay([{ text: "Second.", type: "text" }], {
        model: "claude-other",
      });
      return resolvedTextStep("Second.", { providerReplay: changedReplay });
    },
  );
  await expect(changedIdentity).rejects.toThrow(PAUSE_ERROR);

  const changedContainer = completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    pausedTextStep("First.", {
      providerReplay: replay([{ text: "First.", type: "text" }], {
        container: "container-1",
      }),
    }),
    () =>
      resolvedTextStep("Second.", {
        providerReplay: replay([{ text: "Second.", type: "text" }], {
          container: "container-2",
        }),
      }),
  );
  await expect(changedContainer).rejects.toThrow(PAUSE_ERROR);
});

test("keeps final client tool calls in a combined continuation", async () => {
  const finalCall = emptyProviderToolCall("call-1", "read");
  const final = replayToolStep("Use the client tool.", finalCall.id);

  const combined = await completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    pausedTextStep("First."),
    () => Promise.resolve(final),
  );

  const expectedBlocks = [
    { text: "First.", type: "text" as const },
    ...(final.providerReplay?.blocks ?? []),
  ];
  expect(combined.toolCalls).toEqual([finalCall]);
  expect(combined.providerReplay?.blocks).toEqual(expectedBlocks);
});

test("limits provider-directed pause continuations", async function enforcesPauseLimit() {
  const complete = vi.fn(() => Promise.resolve(pausedTextStep("Again.")));

  await expect(
    completeAnthropicPauseTurns(
      INITIAL_MESSAGES,
      pausedTextStep("First."),
      complete,
    ),
  ).rejects.toThrow(
    "The Anthropic response remained paused after 5 continuations",
  );
  expect(complete).toHaveBeenCalledTimes(5);
});

test("propagates a continuation abort unchanged", async () => {
  const aborted = new DOMException("Stopped", "AbortError");

  await expect(
    completeAnthropicPauseTurns(
      INITIAL_MESSAGES,
      pausedTextStep("First."),
      () => Promise.reject(aborted),
    ),
  ).rejects.toBe(aborted);
});
