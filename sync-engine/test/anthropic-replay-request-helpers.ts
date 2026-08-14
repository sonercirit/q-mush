import type { AgentConversationMessage } from "../../shared/agent-loop.ts";
import type { AnthropicAssistantReplay } from "../../shared/anthropic-replay.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  ANTHROPIC_READ_CALL,
  anthropicHarness,
  doneAnthropicEvents,
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

export function anthropicReplayConversation(options: {
  readonly providerReplay?: AnthropicAssistantReplay;
  readonly toolContent: string;
}): readonly AgentConversationMessage[] {
  return [
    { content: "Hello", role: "user" },
    anthropicAssistant(options.providerReplay),
    {
      content: options.toolContent,
      role: "tool",
      toolCallId: ANTHROPIC_READ_CALL.id,
      toolName: ANTHROPIC_READ_CALL.name,
    },
    { content: "Continue", role: "user" },
  ];
}

export function signedReplayHarness(): AnthropicHarness {
  return anthropicHarness([doneAnthropicEvents()]);
}

export async function capturedAssistantContent(
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
