import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

const STORED_SESSION_STATE_SELECTION = {
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
