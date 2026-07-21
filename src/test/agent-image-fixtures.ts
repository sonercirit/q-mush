import type { AgentImage } from "../agent-images.ts";
import type { AgentSessionMessage } from "../session-model.ts";

export const TEST_AGENT_IMAGE: AgentImage = {
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mediaType: "image/png",
  name: "pixel.png",
};

export function testUserImageMessage(
  id: string,
  content: string,
): AgentSessionMessage {
  return {
    content,
    createdAt: 2,
    id,
    images: [TEST_AGENT_IMAGE],
    role: "user",
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
}
