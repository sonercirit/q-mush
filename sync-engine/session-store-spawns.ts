import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { ownedActiveSessionCondition } from "./session-store-condition.ts";
import { storedSessionExists } from "./session-store-state.ts";
import {
  appendSystemStoredMessage,
  storedUserMessageValues,
} from "./session-store-values.ts";

export interface SpawnedSessionLink {
  readonly parentGeneration: number;
  readonly parentId: string;
}

export interface PendingSpawnedSession {
  readonly detail: AgentSessionDetail;
  readonly userId: string;
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
        isNotNull(agentSessions.parentExecutionGeneration),
        eq(agentSessions.isDeleted, false),
        eq(agentSessions.runnerRequired, false),
        inArray(agentSessions.status, ["idle", "stopped", "failed"]),
      ),
    )
    .all()
    .flatMap(({ id, userId }) => {
      const detail = read(userId, id);
      return detail === undefined ? [] : [{ detail, userId }];
    });
}

export function spawnedSessionLink(
  database: AppDatabase,
  userId: string,
  sessionId: string,
): SpawnedSessionLink | undefined {
  const stored = database
    .select({
      parentGeneration: agentSessions.parentExecutionGeneration,
      parentId: agentSessions.parentSessionId,
    })
    .from(agentSessions)
    .where(ownedActiveSessionCondition(userId, sessionId))
    .get();
  if (stored?.parentId == null || stored.parentGeneration === null) {
    return undefined;
  }
  return {
    parentGeneration: stored.parentGeneration,
    parentId: stored.parentId,
  };
}

export function appendSpawnedSessionReport(options: {
  readonly childGeneration: number;
  readonly childId: string;
  readonly content: string;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly parentGeneration: number;
  readonly parentId: string;
  readonly userId: string;
}): boolean {
  return options.database.transaction((transaction) => {
    const parentCondition = and(
      ownedActiveSessionCondition(options.userId, options.parentId),
      eq(agentSessions.executionGeneration, options.parentGeneration),
      eq(agentSessions.runnerRequired, false),
      inArray(agentSessions.status, ["running", "idle"]),
    );
    if (!storedSessionExists(transaction, parentCondition)) {
      return false;
    }
    const claimed = transaction
      .update(agentSessions)
      .set({
        parentExecutionGeneration: null,
        parentSessionId: null,
      })
      .where(
        and(
          ownedActiveSessionCondition(options.userId, options.childId),
          eq(agentSessions.executionGeneration, options.childGeneration),
          eq(agentSessions.parentSessionId, options.parentId),
          eq(agentSessions.parentExecutionGeneration, options.parentGeneration),
        ),
      )
      .returning({ id: agentSessions.id })
      .all();
    if (claimed.length === 0) {
      return false;
    }
    appendSystemStoredMessage({
      database: transaction,
      generateId: options.generateId,
      message: storedUserMessageValues(options.content),
      now: options.now,
      sessionId: options.parentId,
      userId: options.userId,
    });
    transaction
      .update(agentSessions)
      .set({
        updatedAt: new Date(options.now),
        updatedById: SYSTEM_ID,
      })
      .where(parentCondition)
      .run();
    return true;
  });
}
