import { updatedAuditFields } from "../shared/audit.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { SessionSystemWriteTarget } from "./session-pending-inputs.ts";
import {
  errorMessageValues,
  insertStoredMessage,
} from "./session-store-values.ts";
import { updateSessionAndEndGenerationTurn } from "./session-turn-store.ts";

export interface RestartFailureTarget extends SessionSystemWriteTarget {
  readonly condition: Parameters<
    typeof updateSessionAndEndGenerationTurn
  >[0]["condition"];
  readonly generation: number;
}

export function failRestartSession(
  options: RestartFailureTarget,
  error: string,
): boolean {
  const failedValues = {
    ...updatedAuditFields(SYSTEM_ID, options.now),
    interruptedHandoff: null,
    restartHandoff: null,
    status: "failed" as const,
  };
  if (
    !updateSessionAndEndGenerationTurn({
      condition: options.condition,
      database: options.database,
      generation: options.generation,
      now: options.now,
      sessionId: options.sessionId,
      values: failedValues,
    })
  ) {
    return false;
  }
  insertStoredMessage(options.database, errorMessageValues(error), {
    actorId: SYSTEM_ID,
    id: options.generateId(options.now),
    now: options.now,
    sessionId: options.sessionId,
    userId: options.userId,
  });
  return true;
}
