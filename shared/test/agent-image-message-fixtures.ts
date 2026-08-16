import type { AgentImage } from "../agent-images.ts";
import type { AgentSessionMessage } from "../session-model.ts";

export function createTestUserImageMessage(
  image: AgentImage,
  id: string,
  content: string,
): AgentSessionMessage {
  return {
    content,
    createdAt: 2,
    id,
    images: [image],
    role: "user",
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
}
