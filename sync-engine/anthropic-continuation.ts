import type {
  AgentConversationMessage,
  AgentModelStep,
  AgentTokenUsage,
} from "../shared/agent-loop.ts";
import {
  anthropicReplayAssistantText,
  anthropicReplayMatchesAssistant,
  createAnthropicAssistantReplay,
  type AnthropicAssistantReplay,
} from "../shared/anthropic-replay.ts";

const INVALID_PAUSE =
  "The Anthropic response paused with content that cannot be continued safely";
const MAX_PAUSE_CONTINUATIONS = 5;

const ANTHROPIC_PAUSE_LIMIT = `The Anthropic response remained paused after ${String(
  MAX_PAUSE_CONTINUATIONS,
)} continuations`;

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

interface TrimmedContinuation {
  readonly content: string;
  readonly replay: AnthropicAssistantReplay;
}

function trimmedContinuation(
  replay: AnthropicAssistantReplay,
): TrimmedContinuation {
  const blocks = [...replay.blocks];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const trailing = blocks[index];
    if (trailing?.type !== "text") continue;
    const text = trailing.text.trimEnd();
    if (text.length === 0) {
      blocks.splice(index, 1);
      continue;
    }
    if (text !== trailing.text) {
      blocks[index] = { ...trailing, text };
    }
    break;
  }
  return {
    content: anthropicReplayAssistantText(blocks),
    replay: createAnthropicAssistantReplay(blocks, replay, replay.container),
  };
}

function continuationAssistant(
  replay: AnthropicAssistantReplay,
  container: string | undefined,
): AgentConversationMessage {
  const trimmed = trimmedContinuation(replay);
  return {
    content: trimmed.content,
    providerReplay:
      container === undefined || trimmed.replay.container === container
        ? trimmed.replay
        : createAnthropicAssistantReplay(
            trimmed.replay.blocks,
            trimmed.replay,
            container,
          ),
    role: "assistant",
    toolCalls: [],
  };
}

function completedStep(options: {
  readonly content: string;
  readonly costUsd: number | null;
  readonly providerReplay: AnthropicAssistantReplay | undefined;
  readonly step: AgentModelStep;
  readonly thinking: string;
  readonly tokenUsage: AgentTokenUsage | null;
}): AgentModelStep {
  const { providerReplay, step } = options;
  return {
    content: options.content,
    contextTokens: step.contextTokens,
    costUsd: options.costUsd,
    ...(step.providerContinuation === "anthropic_replay_unavailable"
      ? { providerContinuation: step.providerContinuation }
      : {}),
    ...(providerReplay === undefined ? {} : { providerReplay }),
    thinking: options.thinking,
    tokenUsage: options.tokenUsage,
    toolCalls: step.toolCalls,
    ...(step.truncation === undefined ? {} : { truncation: step.truncation }),
  };
}

function combinableReplay(
  step: AgentModelStep,
  identity: ReplayIdentity,
  container: string | undefined,
): AnthropicAssistantReplay | undefined {
  const replay = step.providerReplay;
  return replay !== undefined &&
    sameReplayIdentity(replay, identity) &&
    (replay.container === undefined ||
      container === undefined ||
      replay.container === container) &&
    anthropicReplayMatchesAssistant(replay, step.content, step.toolCalls)
    ? replay
    : undefined;
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
  let blocks: readonly AnthropicAssistantReplay["blocks"][number][] = [];
  let identity: ReplayIdentity | undefined;
  let continuations = 0;

  for (;;) {
    const paused = step.providerContinuation === "anthropic_pause_turn";
    content += step.content;
    thinking += step.thinking;
    costUsd =
      costUsd === undefined ? step.costUsd : addCost(costUsd, step.costUsd);
    tokenUsage =
      tokenUsage === undefined
        ? step.tokenUsage
        : addUsage(tokenUsage, step.tokenUsage);

    if (!paused) {
      // The terminal step ends the turn locally, so an unusable replay only
      // costs a future cache prefix; nothing partial reaches the provider.
      // Reaching this branch means at least one paused step set the identity.
      const replay =
        identity === undefined
          ? undefined
          : combinableReplay(step, identity, container);
      const completed =
        replay === undefined && step.toolCalls.length > 0
          ? {
              ...step,
              providerContinuation: "anthropic_replay_unavailable" as const,
            }
          : step;
      return completedStep({
        content,
        costUsd,
        providerReplay:
          identity === undefined || replay === undefined
            ? undefined
            : createAnthropicAssistantReplay(
                [...blocks, ...replay.blocks],
                identity,
                container ?? replay.container,
              ),
        step: completed,
        thinking,
        tokenUsage,
      });
    }

    // Every further paused step is replayed back to the provider verbatim, so
    // its blocks must reproduce the assistant message exactly.
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
    blocks = [...blocks, ...replay.blocks];
    if (step.toolCalls.length > 0 || step.truncation !== undefined) {
      throw new Error(INVALID_PAUSE);
    }
    if (continuations >= MAX_PAUSE_CONTINUATIONS) {
      throw new Error(ANTHROPIC_PAUSE_LIMIT);
    }
    continuations += 1;
    messages = [...messages, continuationAssistant(replay, container)];
    step = await complete(messages, { content, thinking });
  }
}
