import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { SessionSystemWriteTarget } from "./session-pending-inputs.ts";
import { terminalSessionValues } from "./session-store-persistence.ts";
import {
  errorMessageValues,
  insertStoredMessage,
} from "./session-store-values.ts";
import {
  activeSessionTurnId,
  updateSessionAndEndGenerationTurn,
} from "./session-turn-store.ts";

export interface RestartFailureTarget extends SessionSystemWriteTarget {
  readonly condition: Parameters<
    typeof updateSessionAndEndGenerationTurn
  >[0]["condition"];
  readonly generation: number;
}

export function settleSessionFailure(
  options: RestartFailureTarget,
  error: string,
): boolean {
  const timing = options.database
    .select({
      activeDurationMs: agentSessions.activeDurationMs,
      activeStartedAt: agentSessions.activeStartedAt,
    })
    .from(agentSessions)
    .where(options.condition)
    .get();
  if (timing === undefined) {
    return false;
  }
  const turnId = activeSessionTurnId(options.database, options.sessionId);
  if (
    !updateSessionAndEndGenerationTurn({
      condition: options.condition,
      database: options.database,
      generation: options.generation,
      now: options.now,
      sessionId: options.sessionId,
      values: terminalSessionValues(timing, "failed", options.now),
    })
  ) {
    return false;
  }
  insertStoredMessage(
    options.database,
    { ...errorMessageValues(error), turnId },
    {
      actorId: SYSTEM_ID,
      id: options.generateId(options.now),
      now: options.now,
      sessionId: options.sessionId,
      userId: options.userId,
    },
  );
  return true;
}
