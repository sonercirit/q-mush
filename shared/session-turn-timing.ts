import type {
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionTurn,
} from "./session-model.ts";

const ACTIVE_TURN_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  "queued",
  "running",
  "paused",
]);

interface SessionTurnTiming {
  readonly activeStartedAt: number | undefined;
  readonly completedStarts: ReadonlyMap<string, number>;
}

function persistedTurnTiming(
  messages: readonly AgentSessionMessage[],
  turns: readonly AgentSessionTurn[],
  status: AgentSessionStatus,
): SessionTurnTiming {
  const completedStarts = new Map<string, number>();
  const finalMessageIds = new Map<string, string>();
  for (const message of messages) {
    if (message.turnId !== null && message.turnId !== undefined) {
      finalMessageIds.set(message.turnId, message.id);
    }
  }
  for (const turn of turns) {
    const boundaryMessageId =
      turn.boundaryMessageId ?? finalMessageIds.get(turn.id);
    if (turn.endedAt !== null && boundaryMessageId !== undefined) {
      completedStarts.set(boundaryMessageId, turn.startedAt);
    }
  }
  return {
    activeStartedAt: ACTIVE_TURN_STATUSES.has(status)
      ? turns.findLast(({ endedAt }) => endedAt === null)?.startedAt
      : undefined,
    completedStarts,
  };
}

export function sessionTurnTiming(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
  turns: readonly AgentSessionTurn[] | undefined,
): SessionTurnTiming {
  if (turns !== undefined && turns.length > 0) {
    return persistedTurnTiming(messages, turns, status);
  }
  return {
    activeStartedAt: activeTurnStartedAt(messages, status),
    completedStarts: legacyTurnStartedAtByMessage(messages, status),
  };
}

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

function legacyTurnStartedAtByMessage(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): ReadonlyMap<string, number> {
  const starts = new Map<string, number>();
  let startedAt: number | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      startedAt = message.createdAt;
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

function activeTurnStartedAt(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): number | undefined {
  return ACTIVE_TURN_STATUSES.has(status)
    ? turnStartedAt(messages, messages.length - 1)
    : undefined;
}
