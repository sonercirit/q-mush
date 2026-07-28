import type {
  AgentSessionMessage,
  AgentSessionStatus,
} from "./session-model.ts";

const ACTIVE_TURN_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  "queued",
  "running",
  "paused",
]);

function turnStartedAt(
  messages: readonly AgentSessionMessage[],
  endIndex: number,
): number | undefined {
  for (let index = endIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.createdAt;
  }
  return undefined;
}

export function sessionTurnStartedAtByMessage(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): ReadonlyMap<string, number> {
  const starts = new Map<string, number>();
  let startedAt: number | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      startedAt = message.createdAt;
      continue;
    }
    const finalMessage = index === messages.length - 1;
    if (
      startedAt !== undefined &&
      (messages[index + 1]?.role === "user" ||
        (finalMessage && !ACTIVE_TURN_STATUSES.has(status)))
    ) {
      starts.set(message.id, startedAt);
    }
  }
  return starts;
}

export function activeTurnStartedAt(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): number | undefined {
  return ACTIVE_TURN_STATUSES.has(status)
    ? turnStartedAt(messages, messages.length - 1)
    : undefined;
}
