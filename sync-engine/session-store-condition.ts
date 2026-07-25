import { and, eq } from "drizzle-orm";
import { agentSessions } from "../shared/database/schema.ts";

export function ownedActiveSessionCondition(userId: string, sessionId: string) {
  return activeSessionOwnerCondition({ sessionId, userId });
}

export function activeSessionOwnerCondition(options: {
  readonly sessionId: string;
  readonly userId: string;
}) {
  return and(
    eq(agentSessions.id, options.sessionId),
    eq(agentSessions.userId, options.userId),
    eq(agentSessions.isDeleted, false),
  );
}
