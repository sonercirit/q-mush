import { agentMessages } from "../shared/database/schema.ts";

export const STORED_SESSION_MESSAGE_SELECTION = {
  cacheWriteInputTokens: agentMessages.cacheWriteInputTokens,
  cachedInputTokens: agentMessages.cachedInputTokens,
  content: agentMessages.content,
  createdAt: agentMessages.createdAt,
  id: agentMessages.id,
  images: agentMessages.images,
  inputTokens: agentMessages.inputTokens,
  outputTokens: agentMessages.outputTokens,
  role: agentMessages.role,
  toolCallId: agentMessages.toolCallId,
  toolCalls: agentMessages.toolCalls,
  toolName: agentMessages.toolName,
  turnId: agentMessages.turnId,
};

export const INTERNAL_SESSION_MESSAGE_SELECTION = {
  ...STORED_SESSION_MESSAGE_SELECTION,
  providerReplay: agentMessages.providerReplay,
};
