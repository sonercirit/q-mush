import type { AgentConversationMessage } from "../../shared/agent-loop.ts";

interface AgentRequestRecorder {
  readonly requests: AgentConversationMessage[][];
  record(messages: readonly AgentConversationMessage[]): void;
}

export function createAgentRequestRecorder(
  cloneMessages = false,
): AgentRequestRecorder {
  const requests: AgentConversationMessage[][] = [];
  return {
    requests,
    record(messages) {
      requests.push(
        cloneMessages
          ? Array.from(messages, (message) => ({ ...message }))
          : [...messages],
      );
    },
  };
}

export const ASSISTANT_PREFILL_ERROR =
  "This model does not support assistant message prefill. The conversation must end with a user message.";

export function assistantPrefillError(
  messages: readonly AgentConversationMessage[],
): Error | undefined {
  return messages.at(-1)?.role === "user"
    ? undefined
    : new Error(ASSISTANT_PREFILL_ERROR);
}
