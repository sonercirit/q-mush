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
  const first = containedPauseStep({
    contextTokens: 10,
    costUsd: 0.1,
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

function containedPauseStep(
  options: Partial<AgentModelStep> = {},
): AgentModelStep {
  return pausedTextStep("First. ", {
    providerReplay: replay([{ text: "First. ", type: "text" }], {
      container: "container-1",
    }),
    thinking: "Think one. ",
    ...options,
  });
}

const SECOND_REPLAY_VARIANTS = {
  "a changed replay container": { container: "container-2" },
  "a foreign replay identity": { model: "claude-other" },
} as const;

function secondStep(
  variant: keyof typeof SECOND_REPLAY_VARIANTS,
  options: Partial<AgentModelStep>,
): AgentModelStep {
  return textStep("Second.", {
    providerReplay: replay(
      [{ text: "Second.", type: "text" }],
      SECOND_REPLAY_VARIANTS[variant],
    ),
    thinking: "Think two.",
    ...options,
  });
}

test.each(["a changed replay container", "a foreign replay identity"] as const)(
  "rejects %s while pausing again",
  async (variant) => {
    const rejected = completeAnthropicPauseTurns(
      INITIAL_MESSAGES,
      containedPauseStep(),
      () =>
        Promise.resolve(
          secondStep(variant, {
            providerContinuation: "anthropic_pause_turn",
          }),
        ),
    );

    await expect(rejected).rejects.toThrow(PAUSE_ERROR);
  },
);

test.each([
  [
    "an unusable replay",
    (): AgentModelStep =>
      providerStep("Second.", {
        thinking: "Think two.",
      }),
  ],
  [
    "a mismatched replay",
    (): AgentModelStep =>
      textStep("Second.", {
        providerReplay: replay([{ text: "Other.", type: "text" }]),
        thinking: "Think two.",
      }),
  ],
  [
    "a foreign replay identity",
    (): AgentModelStep => secondStep("a foreign replay identity", {}),
  ],
  [
    "a changed replay container",
    (): AgentModelStep => secondStep("a changed replay container", {}),
  ],
])(
  "completes a final continuation step carrying %s without replay",
  async (_label, finalStep: () => AgentModelStep) => {
    const combined = await completeAnthropicPauseTurns(
      INITIAL_MESSAGES,
      containedPauseStep(),
      () => Promise.resolve(finalStep()),
    );

    expect(combined).toMatchObject({
      content: "First. Second.",
      thinking: "Think one. Think two.",
    });
    expect(combined).not.toHaveProperty("providerReplay");
  },
);

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
