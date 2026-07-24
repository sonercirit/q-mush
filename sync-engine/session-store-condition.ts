import { and, eq, type SQL } from "drizzle-orm";
import { agentSessions } from "../shared/database/schema.ts";

export function ownedActiveSessionCondition(
  userId: string,
  sessionId: string,
): SQL | undefined {
  return and(
    eq(agentSessions.id, sessionId),
    eq(agentSessions.userId, userId),
    eq(agentSessions.isDeleted, false),
  );
}
