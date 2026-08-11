import { canonicalAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { summaryFromDetail } from "./session-codec.ts";

export function replaceSessionSummary(
  sessions: readonly AgentSessionSummary[],
  detail: AgentSessionDetail,
): readonly AgentSessionSummary[] {
  const summary = summaryFromDetail(detail);
  return [summary, ...sessions.filter(({ id }) => id !== summary.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

export function mergeNewerSelectedSessionSummary(
  sessions: readonly AgentSessionSummary[],
  selectedId: string | undefined,
  detail: AgentSessionDetail | undefined,
): readonly AgentSessionSummary[] {
  const selectedDetail = detail?.id === selectedId ? detail : undefined;
  const fetched = sessions.find(({ id }) => id === selectedId);
  return selectedDetail !== undefined &&
    fetched !== undefined &&
    selectedDetail.updatedAt > fetched.updatedAt
    ? replaceSessionSummary(sessions, selectedDetail)
    : sessions;
}

function serializedDataMatches(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function sessionMessageMatches(
  left: AgentSessionMessage | undefined,
  right: AgentSessionMessage | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.content === right.content &&
    left.createdAt === right.createdAt &&
    left.id === right.id &&
    left.role === right.role &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName &&
    serializedDataMatches(left.attachments, right.attachments) &&
    serializedDataMatches(left.images, right.images) &&
    serializedDataMatches(left.tokenUsage, right.tokenUsage) &&
    serializedDataMatches(left.toolCalls, right.toolCalls)
  );
}

function sessionDetailMatches(
  left: AgentSessionDetail | undefined,
  right: AgentSessionDetail | undefined,
): boolean {
  if (left === right) return true;
  if (right === undefined || left === undefined) return false;
  const { messages: leftMessages, ...leftMetadata } = left;
  const { messages: rightMessages, ...rightMetadata } = right;
  return (
    leftMessages.length === rightMessages.length &&
    leftMessages.every((message, index) =>
      sessionMessageMatches(message, rightMessages[index]),
    ) &&
    serializedDataMatches(leftMetadata, rightMetadata)
  );
}

export const sessionDataMatches = sessionDetailMatches;

export function sessionSummariesMatch(
  left: readonly AgentSessionSummary[] | undefined,
  right: readonly AgentSessionSummary[] | undefined,
): boolean {
  return serializedDataMatches(left, right);
}

function canonicalSessionMessages(
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail["messages"] {
  return canonicalAgentSessionMessages(messages);
}

function retainUnchangedMessages(
  current: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail["messages"] {
  const currentById = new Map(
    current.messages.map((message) => [message.id, message]),
  );
  return messages.map((message) => {
    const existing = currentById.get(message.id);
    return sessionMessageMatches(existing, message) && existing !== undefined
      ? existing
      : message;
  });
}

export function sortedMessages(
  detail: AgentSessionDetail,
): AgentSessionDetail["messages"] {
  if (
    detail.messages.some((message) => isStreamedMessage(detail.id, message))
  ) {
    return detail.messages;
  }
  for (let index = 1; index < detail.messages.length; index += 1) {
    const previous = detail.messages[index - 1];
    const current = detail.messages[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      (previous.createdAt > current.createdAt ||
        (previous.createdAt === current.createdAt && previous.id > current.id))
    ) {
      return canonicalSessionMessages(detail.messages);
    }
  }
  return detail.messages;
}

export function retainUnchangedSessionData(
  current: AgentSessionDetail | undefined,
  detail: AgentSessionDetail,
): AgentSessionDetail {
  const orderedMessages = sortedMessages(detail);
  if (current?.id !== detail.id)
    return orderedMessages === detail.messages
      ? detail
      : { ...detail, messages: orderedMessages };

  const agentFile = serializedDataMatches(current.agentFile, detail.agentFile)
    ? current.agentFile
    : detail.agentFile;
  const messages = retainUnchangedMessages(current, orderedMessages);
  return agentFile !== detail.agentFile ||
    messages.some((message, index) => message !== detail.messages[index])
    ? { ...detail, agentFile, messages }
    : detail;
}

export function streamedMessageId(
  sessionId: string,
  role: "assistant" | "thinking",
): string {
  return `stream:${sessionId}:${role}`;
}

export function isStreamedMessage(
  sessionId: string,
  message: AgentSessionMessage,
): boolean {
  return (
    message.role === "compaction_request" ||
    message.id === streamedMessageId(sessionId, "thinking") ||
    message.id === streamedMessageId(sessionId, "assistant")
  );
}
