import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

import { selectedString } from "./database-count.ts";

const SESSION_USER_ID_SELECTION = {
  column: agentSessions.userId,
  table: agentSessions,
} as const;

export function readStoredSessionUserId(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): string | undefined {
  return selectedString(database, SESSION_USER_ID_SELECTION, condition);
}

export function requireRunningSessionUserId(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): string {
  const userId = readStoredSessionUserId(database, condition);
  if (userId === undefined) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
  return userId;
}

const STORED_SESSION_STATE_SELECTION = {
  currentSegment: agentSessions.currentSegment,
  executionGeneration: agentSessions.executionGeneration,
  parentExecutionGeneration: agentSessions.parentExecutionGeneration,
  parentSessionId: agentSessions.parentSessionId,
  runnerRequired: agentSessions.runnerRequired,
  status: agentSessions.status,
};

export function readStoredSessionState(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
) {
  return database
    .select(STORED_SESSION_STATE_SELECTION)
    .from(agentSessions)
    .where(condition)
    .get();
}
