import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createdAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export interface PendingSpawnedSession {
  readonly detail: AgentSessionDetail;
  readonly userId: string;
}

function ownedSessionCondition(userId: string, sessionId: string) {
  return and(
    eq(agentSessions.id, sessionId),
    eq(agentSessions.userId, userId),
    eq(agentSessions.isDeleted, false),
  );
}

export function pendingSpawnedSessions(
  database: AppDatabase,
  read: (userId: string, sessionId: string) => AgentSessionDetail | undefined,
): readonly PendingSpawnedSession[] {
  return database
    .select({ id: agentSessions.id, userId: agentSessions.userId })
    .from(agentSessions)
    .where(
      and(
        isNotNull(agentSessions.parentSessionId),
        eq(agentSessions.isDeleted, false),
        inArray(agentSessions.status, ["idle", "stopped", "failed"]),
      ),
    )
    .all()
    .flatMap(({ id, userId }) => {
      const detail = read(userId, id);
      return detail === undefined ? [] : [{ detail, userId }];
    });
}

export function parentSessionId(
  database: AppDatabase,
  userId: string,
  sessionId: string,
): string | undefined {
  return (
    database
      .select({ parentSessionId: agentSessions.parentSessionId })
      .from(agentSessions)
      .where(ownedSessionCondition(userId, sessionId))
      .get()?.parentSessionId ?? undefined
  );
}

export function appendSpawnedSessionReport(options: {
  readonly childId: string;
  readonly content: string;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly parentId: string;
  readonly userId: string;
}): boolean {
  return options.database.transaction((transaction) => {
    const parentCondition = ownedSessionCondition(
      options.userId,
      options.parentId,
    );
    const parentRows = transaction
      .select()
      .from(agentSessions)
      .where(parentCondition)
      .all();
    if (parentRows.length === 0) {
      return false;
    }
    const claimed = transaction
      .update(agentSessions)
      .set({ parentSessionId: null })
      .where(
        and(
          ownedSessionCondition(options.userId, options.childId),
          eq(agentSessions.parentSessionId, options.parentId),
        ),
      )
      .returning({ id: agentSessions.id })
      .all();
    if (claimed.length === 0) {
      return false;
    }
    const reportValues = {
      ...createdAuditFields(SYSTEM_ID, options.now),
      content: options.content,
      id: options.generateId(options.now),
      role: "user" as const,
      sessionId: options.parentId,
      userId: options.userId,
    };
    const insertReport = transaction.insert(agentMessages);
    insertReport.values(reportValues).run();
    const parentUpdated = {
      updatedAt: new Date(options.now),
      updatedById: SYSTEM_ID,
    };
    transaction
      .update(agentSessions)
      .set(parentUpdated)
      .where(parentCondition)
      .run();
    return true;
  });
}
