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

interface CompletedTurnTiming {
  readonly endedAt: number | null;
  readonly startedAt: number;
}

interface SessionTurnTiming {
  readonly activeStartedAt: number | undefined;
  readonly completedTimings: ReadonlyMap<string, CompletedTurnTiming>;
}

function completedTiming(
  startedAt: number,
  endedAt: number | null,
): CompletedTurnTiming {
  return { endedAt, startedAt };
}

function persistedTurnTiming(options: {
  readonly messages: readonly AgentSessionMessage[];
  readonly status: AgentSessionStatus;
  readonly turns: readonly AgentSessionTurn[];
}): SessionTurnTiming {
  const completedTimings = new Map<string, CompletedTurnTiming>();
  const finalMessageIds = new Map<string, string>();
  for (const message of options.messages) {
    if (message.turnId !== null && message.turnId !== undefined) {
      finalMessageIds.set(message.turnId, message.id);
    }
  }
  for (const turn of options.turns) {
    const boundaryMessageId =
      turn.boundaryMessageId ?? finalMessageIds.get(turn.id);
    if (turn.endedAt !== null && boundaryMessageId !== undefined) {
      completedTimings.set(
        boundaryMessageId,
        completedTiming(turn.startedAt, turn.endedAt),
      );
    }
  }
  return {
    activeStartedAt: ACTIVE_TURN_STATUSES.has(options.status)
      ? options.turns.findLast(({ endedAt }) => endedAt === null)?.startedAt
      : undefined,
    completedTimings,
  };
}

export function sessionTurnTiming(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
  turns: readonly AgentSessionTurn[] | undefined,
): SessionTurnTiming {
  if (turns === undefined || turns.length === 0) {
    return legacyTurnTiming(messages, status);
  }
  const persisted = persistedTurnTiming({ messages, status, turns });
  const legacyMessages = messages.filter(
    ({ turnId }) => turnId === null || turnId === undefined,
  );
  if (legacyMessages.length === 0) {
    return persisted;
  }
  const lastLegacyMessage = legacyMessages.at(-1);
  const lastLegacyIndex = messages.findLastIndex(
    ({ id }) => id === lastLegacyMessage?.id,
  );
  const hasLaterPersistedMessage = messages
    .slice(lastLegacyIndex + 1)
    .some(({ turnId }) => turnId !== null && turnId !== undefined);
  const legacy = legacyTurnTiming(
    legacyMessages,
    hasLaterPersistedMessage ? "idle" : status,
  );
  return {
    activeStartedAt: persisted.activeStartedAt ?? legacy.activeStartedAt,
    completedTimings: new Map([
      ...legacy.completedTimings,
      ...persisted.completedTimings,
    ]),
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

function legacyTurnTiming(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
): SessionTurnTiming {
  const completedTimings = new Map<string, CompletedTurnTiming>();
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
      completedTimings.set(message.id, completedTiming(startedAt, null));
    }
  }
  return {
    activeStartedAt: ACTIVE_TURN_STATUSES.has(status)
      ? turnStartedAt(messages, messages.length - 1)
      : undefined,
    completedTimings,
  };
}
