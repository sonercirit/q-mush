import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";

const ACTIVE_SESSION_STATE_SELECTION = {
  activeDurationMs: agentSessions.activeDurationMs,
  activeStartedAt: agentSessions.activeStartedAt,
  stepStartedAt: agentSessions.stepStartedAt,
  agentFileContent: agentSessions.agentFileContent,
  agentFileName: agentSessions.agentFileName,
  currentSegment: agentSessions.currentSegment,
  executionGeneration: agentSessions.executionGeneration,
  id: agentSessions.id,
  interruptedHandoff: agentSessions.interruptedHandoff,
  isDeleted: agentSessions.isDeleted,
  status: agentSessions.status,
  updatedAt: agentSessions.updatedAt,
  updatedById: agentSessions.updatedById,
  userId: agentSessions.userId,
};

export function storedActiveSessionState(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  userId?: string,
) {
  return database
    .select(ACTIVE_SESSION_STATE_SELECTION)
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.isDeleted, false),
        userId === undefined ? undefined : eq(agentSessions.userId, userId),
      ),
    )
    .get();
}
