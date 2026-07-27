import type { AgentFile } from "../shared/agent-file.ts";
import type { AppDatabase } from "../shared/database.ts";
import { storedActiveSessionState } from "./session-active-query.ts";
import { storedAgentFile } from "./stored-agent-file.ts";

export function storedSessionAgentFile(
  database: AppDatabase,
  sessionId: string,
): AgentFile | null {
  const stored = storedActiveSessionState(database, sessionId);
  if (stored === undefined) {
    throw new Error("The agent session no longer exists");
  }
  return storedAgentFile(stored);
}
