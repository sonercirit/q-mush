import { expect, test } from "vitest";
import type { AgentModelStep } from "../../shared/agent-loop.ts";
import { createAnthropicAssistantReplay } from "../../shared/anthropic-replay.ts";
import { INVALID_ANTHROPIC_PAUSE } from "../../sync-engine/anthropic-continuation.ts";
import { validateAnthropicStepContinuation } from "../../sync-engine/anthropic-step-continuation.ts";
import {
  emptyProviderToolCall,
  providerStep,
} from "./provider-step-fixtures.ts";

const IDENTITY = {
  model: "claude-requested",
  provenance: "test-provenance",
  resolvedModel: "claude-resolved",
} as const;

function mismatchedReplayStep(
  providerContinuation?: "anthropic_pause_turn",
): AgentModelStep {
  return providerStep("reported content", {
    ...(providerContinuation === undefined ? {} : { providerContinuation }),
    providerReplay: createAnthropicAssistantReplay(
      [{ text: "different replay content", type: "text" }],
      {
        model: IDENTITY.resolvedModel,
        provenance: IDENTITY.provenance,
        requestModel: IDENTITY.model,
      },
    ),
    toolCalls: [emptyProviderToolCall("read-call", "read")],
  });
}

test("rejects an identity-matching client-tool replay that disagrees with the assistant step", () => {
  const step = mismatchedReplayStep();

  expect(step.providerReplay).toBeDefined();
  expect(validateAnthropicStepContinuation(step, IDENTITY)).toMatchObject({
    providerContinuation: "anthropic_replay_unavailable",
  });
});

test("rejects an identity-matching pause_turn replay that disagrees with the assistant step", () => {
  const step = mismatchedReplayStep("anthropic_pause_turn");

  expect(step.providerReplay).toBeDefined();
  expect(() => validateAnthropicStepContinuation(step, IDENTITY)).toThrow(
    INVALID_ANTHROPIC_PAUSE,
  );
});
