import type {
  AgentConversationMessage,
  AgentModelStep,
  AgentTokenUsage,
} from "../shared/agent-loop.ts";
import {
  anthropicReplayMatchesAssistant,
  createAnthropicAssistantReplay,
  type AnthropicAssistantReplay,
} from "../shared/anthropic-replay.ts";

const INVALID_PAUSE =
  "The Anthropic response paused with content that cannot be continued safely";
const MAX_PAUSE_CONTINUATIONS = 5;

const ANTHROPIC_PAUSE_LIMIT =
  "The Anthropic response remained paused after 5 continuations";

interface AnthropicContinuationOutput {
  readonly content: string;
  readonly thinking: string;
}

type AnthropicCompletion = (
  messages: readonly AgentConversationMessage[],
  output: AnthropicContinuationOutput,
) => Promise<AgentModelStep>;

type ReplayIdentity = Pick<AnthropicAssistantReplay, "model" | "provenance">;

function pauseReplay(step: AgentModelStep): AnthropicAssistantReplay {
  const replay = step.providerReplay;
  if (
    replay === undefined ||
    !anthropicReplayMatchesAssistant(replay, step.content, step.toolCalls)
  ) {
    throw new Error(INVALID_PAUSE);
  }
  return replay;
}

function sameReplayIdentity(
  replay: AnthropicAssistantReplay,
  identity: ReplayIdentity,
): boolean {
  return (
    replay.model === identity.model && replay.provenance === identity.provenance
  );
}

function addUsage(
  total: AgentTokenUsage | null,
  current: AgentTokenUsage | null,
): AgentTokenUsage | null {
  if (current === null || total === null) return null;
  return {
    cacheWriteInputTokens:
      total.cacheWriteInputTokens + current.cacheWriteInputTokens,
    cachedInputTokens: total.cachedInputTokens + current.cachedInputTokens,
    inputTokens: total.inputTokens + current.inputTokens,
    outputTokens: total.outputTokens + current.outputTokens,
  };
}

function addCost(total: number | null, current: number | null): number | null {
  return total === null || current === null ? null : total + current;
}

function continuationAssistant(
  step: AgentModelStep,
  replay: AnthropicAssistantReplay,
): AgentConversationMessage {
  return {
    content: step.content,
    providerReplay: replay,
    role: "assistant",
    toolCalls: [],
  };
}

function completedStep(options: {
  readonly blocks: AnthropicAssistantReplay["blocks"][number][];
  readonly content: string;
  readonly container: string | undefined;
  readonly costUsd: number | null;
  readonly identity: ReplayIdentity;
  readonly step: AgentModelStep;
  readonly thinking: string;
  readonly tokenUsage: AgentTokenUsage | null;
}): AgentModelStep {
  const { identity, step } = options;
  return {
    content: options.content,
    contextTokens: step.contextTokens,
    costUsd: options.costUsd,
    providerReplay: createAnthropicAssistantReplay(
      options.blocks,
      identity,
      options.container,
    ),
    ...(step.providerContinuation === undefined
      ? {}
      : { providerContinuation: step.providerContinuation }),
    thinking: options.thinking,
    tokenUsage: options.tokenUsage,
    toolCalls: step.toolCalls,
    ...(step.truncation === undefined ? {} : { truncation: step.truncation }),
  };
}

export async function completeAnthropicPauseTurns(
  initialMessages: readonly AgentConversationMessage[],
  initialStep: AgentModelStep,
  complete: AnthropicCompletion,
): Promise<AgentModelStep> {
  if (initialStep.providerContinuation !== "anthropic_pause_turn") {
    return initialStep;
  }

  let messages = initialMessages;
  let step = initialStep;
  let content = "";
  let container: string | undefined;
  let costUsd: number | null | undefined;
  let thinking = "";
  let tokenUsage: AgentTokenUsage | null | undefined;
  const blocks: AnthropicAssistantReplay["blocks"][number][] = [];
  let identity: ReplayIdentity | undefined;
  let continuations = 0;

  for (;;) {
    const replay = pauseReplay(step);
    if (identity !== undefined && !sameReplayIdentity(replay, identity)) {
      throw new Error(INVALID_PAUSE);
    }
    identity ??= replay;
    if (replay.container !== undefined) {
      if (container !== undefined && container !== replay.container) {
        throw new Error(INVALID_PAUSE);
      }
      container = replay.container;
    }
    blocks.push(...replay.blocks);
    content += step.content;
    thinking += step.thinking;
    costUsd =
      costUsd === undefined ? step.costUsd : addCost(costUsd, step.costUsd);
    tokenUsage =
      tokenUsage === undefined
        ? step.tokenUsage
        : addUsage(tokenUsage, step.tokenUsage);

    const paused = step.providerContinuation === "anthropic_pause_turn";
    if (!paused) {
      return completedStep({
        blocks,
        container,
        content,
        costUsd,
        identity,
        step,
        thinking,
        tokenUsage,
      });
    }
    if (step.toolCalls.length > 0 || step.truncation !== undefined) {
      throw new Error(INVALID_PAUSE);
    }
    if (continuations >= MAX_PAUSE_CONTINUATIONS) {
      throw new Error(ANTHROPIC_PAUSE_LIMIT);
    }
    continuations += 1;
    messages = [...messages, continuationAssistant(step, replay)];
    step = await complete(messages, { content, thinking });
  }
}
