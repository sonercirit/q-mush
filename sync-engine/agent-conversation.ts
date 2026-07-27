import type { AgentConversationMessage } from "../shared/agent-loop.ts";

type AssistantToolCall = Extract<
  AgentConversationMessage,
  { readonly role: "assistant" }
>["toolCalls"][number];

type ToolCallMessage = Readonly<{
  role: string;
  toolCalls?: readonly AssistantToolCall[];
}>;

export function forEachAssistantToolCall(
  messages: readonly ToolCallMessage[],
  visit: (call: AssistantToolCall) => void,
): void {
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        visit(call);
      }
    }
  }
}
