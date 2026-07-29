import { agentMessages } from "../shared/database/schema.ts";

export const STORED_SESSION_MESSAGE_SELECTION = {
  content: agentMessages.content,
  createdAt: agentMessages.createdAt,
  id: agentMessages.id,
  images: agentMessages.images,
  role: agentMessages.role,
  toolCallId: agentMessages.toolCallId,
  toolCalls: agentMessages.toolCalls,
  toolName: agentMessages.toolName,
  turnId: agentMessages.turnId,
};
