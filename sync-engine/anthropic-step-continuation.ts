import type { AgentModelStep } from "../shared/agent-loop.ts";
import { anthropicReplayMatchesAssistant } from "../shared/anthropic-replay.ts";
import { INVALID_ANTHROPIC_PAUSE } from "./anthropic-continuation.ts";
import {
  anthropicReplayMatchesIdentity,
  type AnthropicReplayIdentity,
} from "./anthropic-replay-identity.ts";

export function validateAnthropicStepContinuation(
  step: AgentModelStep,
  identity: AnthropicReplayIdentity,
): AgentModelStep {
  if (
    step.toolCalls.length === 0 &&
    step.providerContinuation !== "anthropic_pause_turn"
  ) {
    return step;
  }
  const replay = step.providerReplay;
  if (
    replay !== undefined &&
    anthropicReplayMatchesIdentity(replay, identity) &&
    anthropicReplayMatchesAssistant(replay, step.content, step.toolCalls)
  ) {
    return step;
  }
  if (step.providerContinuation === "anthropic_pause_turn") {
    throw new Error(INVALID_ANTHROPIC_PAUSE);
  }
  return { ...step, providerContinuation: "anthropic_replay_unavailable" };
}
