import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

function queuedSessionCondition(userId?: string) {
  return and(
    userId === undefined ? undefined : eq(agentSessions.userId, userId),
    eq(agentSessions.isDeleted, false),
    eq(agentSessions.status, "queued"),
  );
}

export function queuedSessionOwnerIds(
  database: AppDatabase,
): readonly string[] {
  return database
    .selectDistinct({ userId: agentSessions.userId })
    .from(agentSessions)
    .where(queuedSessionCondition())
    .orderBy(asc(agentSessions.userId))
    .all()
    .map(({ userId }) => userId);
}

export function queuedSessionDetails(
  database: AppDatabase,
  userId: string,
  readDetail: (
    userId: string,
    sessionId: string,
  ) => AgentSessionDetail | undefined,
): readonly AgentSessionDetail[] {
  const details: AgentSessionDetail[] = [];
  for (const { id } of database
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(queuedSessionCondition(userId))
    .orderBy(asc(agentSessions.createdAt), asc(agentSessions.id))
    .all()) {
    const detail = readDetail(userId, id);
    if (detail?.status === "queued") {
      details.push(detail);
    }
  }
  return details;
}
