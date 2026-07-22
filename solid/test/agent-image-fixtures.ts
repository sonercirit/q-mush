import type { AgentImage } from "../../shared/agent-images.ts";
import type { AgentSessionMessage } from "../../shared/session-model.ts";

const IMAGE_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export const TEST_AGENT_IMAGE: AgentImage = {
  data: IMAGE_DATA,
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
