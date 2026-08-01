import { and, eq, isNotNull } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { appendSystemFollowUp } from "./session-pending-inputs.ts";
import { ownedActiveSessionCondition } from "./session-store-condition.ts";
import {
  storedSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import {
  appendSystemStoredMessage,
  storedUserMessageValues,
} from "./session-store-values.ts";

const REPORTABLE_PARENT_STATUSES = [
  "failed",
  "idle",
  "paused",
  "queued",
  "running",
  "stopped",
] as const;

export interface SpawnedSessionLink {
  readonly parentGeneration: number;
  readonly parentId: string;
}

export function spawnedSessionChildren(
  database: Pick<AppDatabase, "select">,
  userId: string,
  parentId: string,
): readonly string[] {
  const ownerCondition = and(
    eq(agentSessions.userId, userId),
    eq(agentSessions.isDeleted, false),
  );
  const sessions = database
    .select({ id: agentSessions.id, parent: agentSessions.parentSessionId })
    .from(agentSessions)
    .where(ownerCondition)
    .all();
  const descendants: string[] = [];
  const parents = new Set([parentId]);
  for (;;) {
    const children = sessions.filter(
      ({ id, parent }) =>
        parent !== null && parents.has(parent) && !parents.has(id),
    );
    if (children.length === 0) return descendants;
    for (const { id } of children) {
      parents.add(id);
      descendants.push(id);
    }
  }
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
        storedSessionCondition({
          status: ["idle", "stopped", "failed"],
        }),
        isNotNull(agentSessions.parentSessionId),
        isNotNull(agentSessions.parentExecutionGeneration),
        eq(agentSessions.runnerRequired, false),
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

function reportMessageOptions(
  options: Parameters<typeof appendSpawnedSessionReport>[0],
  database: Pick<AppDatabase, "insert" | "select" | "update">,
) {
  return {
    database,
    generateId: options.generateId,
    now: options.now,
    sessionId: options.parentId,
    userId: options.userId,
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
    const parentCondition = storedSessionCondition({
      id: options.parentId,
      status: REPORTABLE_PARENT_STATUSES,
      userId: options.userId,
    });
    const eligibleParent = and(
      parentCondition,
      eq(agentSessions.runnerRequired, false),
    );
    const parent = transaction
      .select({ status: agentSessions.status })
      .from(agentSessions)
      .where(eligibleParent)
      .get();
    if (parent === undefined) {
      return false;
    }
    const childCondition = and(
      storedSessionCondition({
        generation: options.childGeneration,
        id: options.childId,
        userId: options.userId,
      }),
      eq(agentSessions.parentSessionId, options.parentId),
      eq(agentSessions.parentExecutionGeneration, options.parentGeneration),
    );
    if (
      !updateStoredSessions(transaction, childCondition, {
        parentExecutionGeneration: null,
      })
    ) {
      return false;
    }
    switch (parent.status) {
      case "running":
        if (
          !appendSystemFollowUp({
            ...reportMessageOptions(options, transaction),
            clientRequestId: `spawn:${options.childId}:${String(options.childGeneration)}`,
            content: options.content,
            kind: "steer",
          })
        ) {
          return false;
        }
        break;
      case "failed":
      case "idle":
      case "paused":
      case "queued":
      case "stopped":
        appendSystemStoredMessage({
          ...reportMessageOptions(options, transaction),
          message: storedUserMessageValues(options.content),
        });
        break;
    }

    transaction
      .update(agentSessions)
      .set({
        updatedAt: new Date(options.now),
        updatedById: SYSTEM_ID,
      })
      .where(eligibleParent)
      .run();
    return true;
  });
}
