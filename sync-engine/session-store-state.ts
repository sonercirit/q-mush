import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

import { selectedString, selectedValue } from "./database-count.ts";

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

const SESSION_GENERATION_SELECTION = {
  column: agentSessions.executionGeneration,
  table: agentSessions,
} as const;

export function readStoredSessionGeneration(options: {
  readonly condition: SQL | undefined;
  readonly database: Pick<AppDatabase, "select">;
}): number | undefined {
  const generation = selectedValue({
    condition: options.condition,
    database: options.database,
    selected: SESSION_GENERATION_SELECTION,
  });
  return typeof generation === "number" ? generation : undefined;
}

const STORED_SESSION_STATE_SELECTION = {
  currentSegment: agentSessions.currentSegment,
  executionGeneration: agentSessions.executionGeneration,
  parentExecutionGeneration: agentSessions.parentExecutionGeneration,
  parentReportedGeneration: agentSessions.parentReportedGeneration,
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
