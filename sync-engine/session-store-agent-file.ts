import { and, eq } from "drizzle-orm";
import { readAgentFile, type AgentFile } from "../shared/agent-file.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

export function storedSessionAgentFile(
  database: AppDatabase,
  sessionId: string,
): AgentFile | null {
  const stored = database
    .select({
      content: agentSessions.agentFileContent,
      name: agentSessions.agentFileName,
    })
    .from(agentSessions)
    .where(
      and(eq(agentSessions.id, sessionId), eq(agentSessions.isDeleted, false)),
    )
    .get();
  if (stored === undefined) {
    throw new Error("The agent session no longer exists");
  }
  return readAgentFile(
    stored.content === null && stored.name === null ? null : stored,
  );
}
