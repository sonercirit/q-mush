import type { AgentSessionMessage } from "../shared/session-model.ts";

export function createDisplaySessionMessage(
  options: Pick<AgentSessionMessage, "content" | "createdAt" | "id" | "role">,
): AgentSessionMessage {
  const message: AgentSessionMessage = {
    content: options.content,
    createdAt: options.createdAt,
    id: options.id,
    images: [],
    role: options.role,
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
  return message;
}
