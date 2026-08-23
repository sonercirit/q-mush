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
  options: {
    readonly container?: string;
    readonly model?: string;
    readonly provenance?: string;
  } = {},
): AnthropicAssistantReplay {
  return createAnthropicAssistantReplay(
    blocks,
    {
      model: options.model ?? MODEL,
      provenance: options.provenance ?? PROVENANCE,
    },
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

function replayToolBlocks(
  content: string,
  callId: string,
): readonly AnthropicReplayBlock[] {
  return [
    { text: content, type: "text" },
    toolReplayBlock({ id: callId, input: {}, name: "read" }),
  ];
}

function replayToolStep(
  content: string,
  callId: string,
  options?: Partial<AgentModelStep>,
): AgentModelStep {
  const call = emptyProviderToolCall(callId, "read");
  return textStep(content, {
    providerReplay: replay(replayToolBlocks(content, callId)),
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

type Completion = (
  messages: readonly AgentConversationMessage[],
  output: { readonly content: string; readonly thinking: string },
) => Promise<AgentModelStep>;

function scriptedCompletion(
  ...steps: readonly AgentModelStep[]
): ReturnType<typeof vi.fn<Completion>> {
  const complete = vi.fn<Completion>();
  for (const step of steps) complete.mockResolvedValueOnce(step);
  return complete;
}

function continuationResult(
  complete: ReturnType<typeof scriptedCompletion>,
): AgentConversationMessage | undefined {
  return complete.mock.calls[0]?.[0].at(-1);
}

async function runTrimmedContinuation(
  step: AgentModelStep,
  complete: ReturnType<typeof scriptedCompletion>,
): Promise<AgentConversationMessage | undefined> {
  await completeAnthropicPauseTurns(INITIAL_MESSAGES, step, complete);
  return continuationResult(complete);
}

async function expectPauseRejectedBeforeContinuation(
  step: AgentModelStep,
): Promise<void> {
  const complete = scriptedCompletion(textStep("Done."));
  await expectPauseFailure(step, complete);
  expect(complete).not.toHaveBeenCalled();
}

function pauseAssistant(
  step: AgentModelStep,
  content: string,
  container?: string,
): AgentConversationMessage {
  const source = step.providerReplay;
  if (source === undefined) throw new Error("The pause replay is unavailable");
  return {
    content,
    providerReplay: {
      ...source,
      blocks: content.length === 0 ? [] : [{ text: content, type: "text" }],
      ...(container === undefined ? {} : { container }),
    },
    role: "assistant",
    toolCalls: [],
  };
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
  const complete = scriptedCompletion(second, final);

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
    pauseAssistant(first, "First."),
    pauseAssistant(second, "Second.", "container-1"),
  ]);
  expect(complete.mock.calls[1]?.[1]).toEqual({
    content: "First. Second. ",
    thinking: "Think one. Think two. ",
  });
});

test("fails a whitespace-only pause before omitting its assistant turn", async () => {
  const first = pausedTextStep("   ");

  await expectPauseRejectedBeforeContinuation(first);

  expect(first.providerReplay?.blocks).toEqual([{ text: "   ", type: "text" }]);
});

test("fails a pause whose remaining replay blocks are all withheld", async () => {
  await expectPauseRejectedBeforeContinuation(
    pausedTextStep("", {
      providerReplay: replay([
        { text: " ", type: "text" },
        { text: "\t", type: "text" },
      ]),
    }),
  );
});

test("right-trims trailing spaces only in the final preserved pause assistant", async () => {
  const text = "Answer.   ";
  const complete = scriptedCompletion(textStep("Done."));
  const first = pausedTextStep(text);
  const continuation = await runTrimmedContinuation(first, complete);
  expect(continuation).toMatchObject({ content: "Answer." });
  if (continuation?.role !== "assistant") {
    throw new Error("The continuation assistant was not captured");
  }
  const expectedReplay = pauseAssistant(first, "Answer.");
  expect(continuation.providerReplay?.blocks).toEqual(
    expectedReplay.role === "assistant"
      ? expectedReplay.providerReplay?.blocks
      : undefined,
  );
  expect(first.providerReplay?.blocks).toEqual([{ text, type: "text" }]);
});

test("right-trims every trailing text block from content and replay together", async () => {
  const serverBlock: AnthropicReplayBlock = {
    id: "server-call",
    input: { query: "news" },
    name: "web_search",
    type: "server_tool_use",
  };
  const source = replay(
    [
      { signature: "signed-thinking", thinking: "Inspect.", type: "thinking" },
      { text: "Answer. ", type: "text" },
      serverBlock,
      { text: "  ", type: "text" },
      { text: "\t", type: "text" },
    ],
    { container: "container-1" },
  );
  const complete = scriptedCompletion(textStep("Done."));
  const continuation = await runTrimmedContinuation(
    pausedTextStep("Answer.   \t", { providerReplay: source }),
    complete,
  );
  expect(continuation).toEqual({
    content: "Answer.",
    providerReplay: replay(
      [
        {
          signature: "signed-thinking",
          thinking: "Inspect.",
          type: "thinking",
        },
        { text: "Answer.", type: "text" },
        serverBlock,
      ],
      { container: "container-1" },
    ),
    role: "assistant",
    toolCalls: [],
  });
  expect(source.blocks).toHaveLength(5);
});

test("keeps the accumulated container when a later pause omits it", async () => {
  const first = containedPauseStep();
  const second = pausedTextStep("Second.");
  const final = textStep("Done.");
  const complete = scriptedCompletion(second, final);

  await completeAnthropicPauseTurns(INITIAL_MESSAGES, first, complete);

  expect(complete.mock.calls[1]?.[0].at(-1)).toMatchObject({
    providerReplay: { container: "container-1" },
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

function replayIdentityOptions(options: {
  readonly container?: string;
  readonly model?: string;
}): { readonly container?: string; readonly model?: string } {
  const identity: { container?: string; model?: string } = {};
  if (options.container !== undefined) identity.container = options.container;
  if (options.model !== undefined) identity.model = options.model;
  return identity;
}

function terminalToolStep(options: {
  readonly container?: string;
  readonly content?: string;
  readonly model?: string;
  readonly replay?: boolean;
  readonly replayContent?: string;
}): AgentModelStep {
  const content = options.content ?? "Use the tool.";
  const call = emptyProviderToolCall("call-unsafe", "read");
  if (options.replay === false) {
    return providerStep(content, { toolCalls: [call] });
  }
  return replayToolStep(content, call.id, {
    providerReplay: replay(
      replayToolBlocks(options.replayContent ?? content, call.id),
      replayIdentityOptions(options),
    ),
  });
}

async function completeFinalStep(
  step: AgentModelStep,
): Promise<AgentModelStep> {
  return completeAnthropicPauseTurns(
    INITIAL_MESSAGES,
    containedPauseStep(),
    () => Promise.resolve(step),
  );
}

async function expectCompletedWithoutReplay(
  step: AgentModelStep,
): Promise<void> {
  const combined = await completeFinalStep(step);
  expect(combined).toMatchObject({
    content: "First. Second.",
    thinking: "Think one. Think two.",
  });
  expect(combined).not.toHaveProperty("providerReplay");
}

async function expectUnsafeFinalTool(step: AgentModelStep): Promise<void> {
  const combined = await completeFinalStep(step);
  expect(combined.providerContinuation).toBe("anthropic_replay_unavailable");
  expect(combined.toolCalls).toEqual([
    emptyProviderToolCall("call-unsafe", "read"),
  ]);
  expect(combined).not.toHaveProperty("providerReplay");
}

const SECOND_REPLAY_VARIANTS = {
  "a changed replay container": { container: "container-2" },
  "a foreign replay identity": { model: "claude-other" },
  "foreign replay provenance": { provenance: "other-provenance" },
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

test.each([
  "a changed replay container",
  "a foreign replay identity",
  "foreign replay provenance",
] as const)("rejects %s while pausing again", async (variant) => {
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
});

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
    await expectCompletedWithoutReplay(finalStep());
  },
);

test.each([
  [
    "an unusable replay",
    (): AgentModelStep => terminalToolStep({ replay: false }),
  ],
  [
    "a mismatched replay",
    (): AgentModelStep => terminalToolStep({ replayContent: "Other." }),
  ],
  [
    "a foreign replay identity",
    (): AgentModelStep => terminalToolStep({ model: "claude-other" }),
  ],
  [
    "a changed replay container",
    (): AgentModelStep => terminalToolStep({ container: "container-2" }),
  ],
])(
  "marks final client tools with %s unavailable before execution",
  async (_label, finalStep: () => AgentModelStep) => {
    await expectUnsafeFinalTool(finalStep());
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
