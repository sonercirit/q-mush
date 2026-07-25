import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

export function storedSessionExists(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): boolean {
  return (
    database
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(condition)
      .get() !== undefined
  );
}

export function readStoredSessionUserId(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): string | undefined {
  return database
    .select({ userId: agentSessions.userId })
    .from(agentSessions)
    .where(condition)
    .get()?.userId;
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
  executionGeneration: agentSessions.executionGeneration,
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
