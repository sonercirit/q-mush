import type { AgentSessionMessage } from "./session-model.ts";

export function compareAgentSessionMessages(
  left: Pick<AgentSessionMessage, "createdAt" | "id">,
  right: Pick<AgentSessionMessage, "createdAt" | "id">,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function canonicalAgentSessionMessages(
  messages: readonly AgentSessionMessage[],
): readonly AgentSessionMessage[] {
  return [...messages].sort(compareAgentSessionMessages);
}
