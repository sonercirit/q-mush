import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import type { AnthropicAssistantReplay } from "../../shared/anthropic-replay.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  ANTHROPIC_READ_CALL,
  SIGNED_ANTHROPIC_REPLAY,
  type AnthropicHarness,
} from "./anthropic-model-test-helpers.ts";

type AssistantMessage = Extract<
  AgentConversationMessage,
  { readonly role: "assistant" }
>;

export function anthropicAssistant(
  providerReplay?: AnthropicAssistantReplay,
): AssistantMessage {
  const message: AssistantMessage = {
    content: "Reading.",
    role: "assistant",
    toolCalls: [ANTHROPIC_READ_CALL],
  };
  return providerReplay === undefined
    ? message
    : { ...message, providerReplay };
}

// Replays a captured step as the assistant turn of a fresh request so tests
// can assert exactly which blocks the provider receives.
export async function capturedReplayRequest(
  harness: AnthropicHarness,
  step: Awaited<ReturnType<AnthropicHarness["complete"]>>,
  followUp: AgentConversationMessage,
): Promise<unknown> {
  const assistant: AssistantMessage = {
    content: step.content,
    role: "assistant",
    toolCalls: step.toolCalls,
  };
  if (step.providerReplay !== undefined) {
    Object.assign(assistant, { providerReplay: step.providerReplay });
  }
  await harness.complete([
    { content: "Go", role: "user" },
    assistant,
    followUp,
  ]);
  return capturedAssistantContent(harness, 1);
}

async function capturedAssistantContent(
  harness: AnthropicHarness,
  requestIndex = 0,
): Promise<unknown> {
  const body = await harness.requestBody(requestIndex);
  if (!isRecord(body)) {
    throw new Error("The captured body was invalid");
  }
  const messages: unknown = body["messages"];
  const assistant: unknown = Array.isArray(messages) ? messages[1] : undefined;
  if (!isRecord(assistant)) {
    throw new Error("The captured assistant message was invalid");
  }
  return assistant["content"];
}

export { SIGNED_ANTHROPIC_REPLAY, type AnthropicHarness };
