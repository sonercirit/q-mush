import type {
  AgentSessionMessage,
  AgentSessionStatus,
  AgentSessionTurn,
} from "./session-model.ts";

const ACTIVE_STEP_STATUSES: ReadonlySet<AgentSessionStatus> = new Set([
  "queued",
  "running",
  "paused",
]);

interface CompletedStepTiming {
  readonly endedAt: number;
  readonly startedAt: number;
}

interface SessionStepTiming {
  readonly activeStartedAt: number | undefined;
  readonly completedTimings: ReadonlyMap<string, CompletedStepTiming>;
}

function persistedTurnById(
  turns: readonly AgentSessionTurn[] | undefined,
): ReadonlyMap<string, AgentSessionTurn> {
  return new Map((turns ?? []).map((turn) => [turn.id, turn]));
}

function turnForMessage(
  message: AgentSessionMessage,
  turnsById: ReadonlyMap<string, AgentSessionTurn>,
): AgentSessionTurn | undefined {
  return message.turnId === null || message.turnId === undefined
    ? undefined
    : turnsById.get(message.turnId);
}

function transientAssistant(message: AgentSessionMessage): boolean {
  return message.role === "assistant" && message.id.startsWith("stream:");
}

/**
 * Derives model-call steps in one transcript traversal.
 *
 * The transcript does not persist model-call start and settlement events. The
 * closest consistent boundaries are therefore the enclosing turn's start (or
 * the user/message timestamp), the final tool-result timestamp before the next
 * call, and the terminal assistant timestamp. A persisted turn end refines the
 * terminal step's end. After all tool results settle in an active session, the
 * next in-flight step starts at that settlement timestamp.
 */
export function sessionStepTiming(
  messages: readonly AgentSessionMessage[],
  status: AgentSessionStatus,
  turns: readonly AgentSessionTurn[] | undefined,
): SessionStepTiming {
  const activeSession = ACTIVE_STEP_STATUSES.has(status);
  const completedTimings = new Map<string, CompletedStepTiming>();
  const turnsById = persistedTurnById(turns);
  let startedAt: number | undefined;
  let latestStepMessage: AgentSessionMessage | undefined;
  let pendingToolCallIds: Set<string> | undefined;

  const start = (message: AgentSessionMessage): void => {
    startedAt =
      turnForMessage(message, turnsById)?.startedAt ?? message.createdAt;
    latestStepMessage = undefined;
    pendingToolCallIds = undefined;
  };
  const complete = (message: AgentSessionMessage, endedAt: number): void => {
    if (startedAt !== undefined) {
      completedTimings.set(message.id, { endedAt, startedAt });
    }
    startedAt = undefined;
    latestStepMessage = undefined;
    pendingToolCallIds = undefined;
  };

  for (const message of messages) {
    if (message.role === "user") {
      start(message);
      continue;
    }
    if (startedAt === undefined) {
      if (message.role !== "assistant" && message.role !== "thinking") {
        continue;
      }
      start(message);
    }
    latestStepMessage = message;

    if (message.role === "assistant") {
      if (transientAssistant(message)) continue;
      if (message.toolCalls.length === 0) {
        const endedAt =
          turnForMessage(message, turnsById)?.endedAt ?? message.createdAt;
        complete(message, endedAt);
      } else {
        pendingToolCallIds = new Set(message.toolCalls.map(({ id }) => id));
      }
      continue;
    }

    if (message.role === "tool" && pendingToolCallIds !== undefined) {
      if (message.toolCallId !== null) {
        pendingToolCallIds.delete(message.toolCallId);
      }
      if (pendingToolCallIds.size === 0) {
        const settledAt = message.createdAt;
        complete(message, settledAt);
        // Tool settlement is the closest persisted boundary for the next model
        // call, whether that following step is already durable or still live.
        startedAt = settledAt;
      }
    }
  }

  if (
    startedAt !== undefined &&
    !activeSession &&
    latestStepMessage !== undefined
  ) {
    const endedAt =
      turnForMessage(latestStepMessage, turnsById)?.endedAt ??
      latestStepMessage.createdAt;
    complete(latestStepMessage, endedAt);
  }

  return {
    activeStartedAt: activeSession ? startedAt : undefined,
    completedTimings,
  };
}
