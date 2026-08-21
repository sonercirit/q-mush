import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import { appendSystemPendingInput } from "./session-pending-inputs.ts";
import { spawnedSessionCanReport } from "./session-spawn-report.ts";
import { ownedActiveSessionCondition } from "./session-store-condition.ts";
import {
  storedSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";

function parentIsTerminal(status: AgentSessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

const REPORTABLE_PARENT_STATUSES = [
  "completed",
  "failed",
  "idle",
  "paused",
  "queued",
  "running",
  "stopped",
] as const;

export type SpawnedReportDisposition =
  "deferred" | "delivered" | "promoted" | "terminal";

export interface SpawnedSessionLink {
  readonly parentGeneration: number;
  readonly parentId: string;
}

interface SpawnedSessionRow {
  readonly id: string;
  readonly parent: string | null;
  readonly parentGeneration?: number | null;
  readonly status?: AgentSessionDetail["status"];
}

function spawnedDescendants(
  sessions: readonly SpawnedSessionRow[],
  parentId: string,
): readonly SpawnedSessionRow[] {
  const descendants: SpawnedSessionRow[] = [];
  const parents = new Set([parentId]);
  for (;;) {
    const children = sessions.filter(
      ({ id, parent }) =>
        parent !== null && parents.has(parent) && !parents.has(id),
    );
    if (children.length === 0) return descendants;
    for (const child of children) {
      parents.add(child.id);
      descendants.push(child);
    }
  }
}

function ownedSessionCondition(userId: string) {
  return and(
    eq(agentSessions.userId, userId),
    eq(agentSessions.isDeleted, false),
  );
}

function ownedSpawnedSessionRows(
  database: Pick<AppDatabase, "select">,
  userId: string,
) {
  return database
    .select({
      id: agentSessions.id,
      parent: agentSessions.parentSessionId,
      parentGeneration: agentSessions.parentExecutionGeneration,
      status: agentSessions.status,
    })
    .from(agentSessions)
    .where(ownedSessionCondition(userId))
    .all();
}

export function spawnedSessionChildren(
  ...parameters: readonly [Pick<AppDatabase, "select">, string, string]
): readonly string[] {
  const [database, userId, parentId] = parameters;
  return spawnedDescendants(
    ownedSpawnedSessionRows(database, userId),
    parentId,
  ).map(({ id }) => id);
}

const CANCELLABLE_CHILD_STATUSES = ["paused", "queued", "running"] as const;

export function activeSpawnedSessionChildren(
  database: Pick<AppDatabase, "select">,
  userId: string,
  parentId: string,
): readonly string[] {
  const rows = ownedSpawnedSessionRows(database, userId).filter(
    ({ id }) => id !== parentId,
  );
  return spawnedDescendants(rows, parentId).flatMap(
    ({ id, parentGeneration, status }) =>
      parentGeneration !== null &&
      status !== undefined &&
      CANCELLABLE_CHILD_STATUSES.some((candidate) => candidate === status)
        ? [id]
        : [],
  );
}

export interface PendingSpawnedSession {
  readonly detail: AgentSessionDetail;
  readonly userId: string;
}

const REPORTABLE_CHILD_STATUSES = [
  "completed",
  "failed",
  "idle",
  "stopped",
] as const;

export function pendingSpawnedSessions(
  database: AppDatabase,
  read: (userId: string, sessionId: string) => AgentSessionDetail | undefined,
  limit?: number,
): readonly PendingSpawnedSession[] {
  const parentSessions = alias(agentSessions, "callback_parent_sessions");
  const query = database
    .select({ id: agentSessions.id, userId: agentSessions.userId })
    .from(agentSessions)
    .innerJoin(
      parentSessions,
      and(
        eq(parentSessions.id, agentSessions.parentSessionId),
        eq(parentSessions.userId, agentSessions.userId),
        eq(parentSessions.isDeleted, false),
        eq(parentSessions.runnerRequired, false),
        inArray(parentSessions.status, REPORTABLE_PARENT_STATUSES),
      ),
    )
    .where(
      and(
        storedSessionCondition({
          status: REPORTABLE_CHILD_STATUSES,
        }),
        isNotNull(agentSessions.parentSessionId),
        isNotNull(agentSessions.parentExecutionGeneration),
        sql`${agentSessions.parentReportedGeneration} < ${agentSessions.executionGeneration}`,
      ),
    )
    .orderBy(asc(agentSessions.createdAt), asc(agentSessions.id))
    .$dynamic();
  const pending: PendingSpawnedSession[] = [];
  let offset = 0;
  for (;;) {
    const rows =
      limit === undefined
        ? query.all()
        : query.limit(limit).offset(offset).all();
    for (const { id, userId } of rows) {
      const detail = read(userId, id);
      if (detail !== undefined && spawnedSessionCanReport(detail)) {
        pending.push({ detail, userId });
        if (limit !== undefined && pending.length === limit) return pending;
      }
    }
    if (limit === undefined || rows.length < limit) return pending;
    offset += rows.length;
  }
}

export function spawnedSessionLink(
  database: AppDatabase,
  userId: string,
  sessionId: string,
): SpawnedSessionLink | undefined {
  const stored = database
    .select({
      generation: agentSessions.executionGeneration,
      parentGeneration: agentSessions.parentExecutionGeneration,
      parentId: agentSessions.parentSessionId,
      reportedGeneration: agentSessions.parentReportedGeneration,
      runnerRequired: agentSessions.runnerRequired,
      status: agentSessions.status,
    })
    .from(agentSessions)
    .where(ownedActiveSessionCondition(userId, sessionId))
    .get();
  if (
    stored?.parentId == null ||
    stored.parentGeneration === null ||
    (!stored.runnerRequired &&
      stored.reportedGeneration >= stored.generation) ||
    (stored.runnerRequired &&
      stored.status !== "idle" &&
      REPORTABLE_CHILD_STATUSES.some((status) => status === stored.status) &&
      stored.reportedGeneration >= stored.generation)
  ) {
    return undefined;
  }
  return {
    parentGeneration: stored.parentGeneration,
    parentId: stored.parentId,
  };
}

function reportMessageOptions(
  options: Readonly<{
    generateId: IdGenerator;
    now: number;
    parentId: string;
    userId: string;
  }>,
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

interface SpawnedReportOptions {
  readonly childGeneration: number;
  readonly childId: string;
  readonly content: string;
  readonly database: AppDatabase;
  readonly generateId: IdGenerator;
  readonly now: number;
  readonly parentGeneration: number;
  readonly parentId: string;
  readonly userId: string;
}

type SpawnedReportDatabase = Pick<AppDatabase, "insert" | "select" | "update">;
type SpawnedReportValues = Omit<SpawnedReportOptions, "database">;

function callbackDisposition(
  database: SpawnedReportDatabase,
  options: SpawnedReportValues,
): SpawnedReportDisposition | undefined {
  const parentCondition = storedSessionCondition({
    id: options.parentId,
    status: REPORTABLE_PARENT_STATUSES,
    userId: options.userId,
  });
  const eligibleParent = and(
    parentCondition,
    eq(agentSessions.runnerRequired, false),
  );
  const parent = database
    .select({ status: agentSessions.status })
    .from(agentSessions)
    .where(eligibleParent)
    .get();
  if (parent === undefined) {
    return undefined;
  }
  const childCondition = and(
    storedSessionCondition({
      generation: options.childGeneration,
      id: options.childId,
      status: REPORTABLE_CHILD_STATUSES,
      userId: options.userId,
    }),
    eq(agentSessions.parentSessionId, options.parentId),
    eq(agentSessions.parentExecutionGeneration, options.parentGeneration),
    sql`${agentSessions.parentReportedGeneration} < ${options.childGeneration}`,
  );
  if (
    !updateStoredSessions(database, childCondition, {
      parentReportedGeneration: options.childGeneration,
    })
  ) {
    return undefined;
  }
  const appended = appendSystemPendingInput({
    ...reportMessageOptions(options, database),
    clientRequestId: `spawn:${options.childId}:${String(options.childGeneration)}`,
    content: options.content,
    kind: parent.status === "running" ? "steer" : "follow_up",
  });
  if (!appended) return undefined;

  const terminal = parentIsTerminal(parent.status);
  database
    .update(agentSessions)
    .set({
      updatedAt: new Date(options.now),
      updatedById: SYSTEM_ID,
    })
    .where(
      storedSessionCondition({
        id: options.parentId,
        userId: options.userId,
      }),
    )
    .run();
  if (terminal) return "terminal";
  if (parent.status === "idle") return "deferred";
  return parent.status === "running" ? "promoted" : "delivered";
}

export function appendSpawnedSessionReport(
  options: SpawnedReportOptions,
): SpawnedReportDisposition | undefined {
  return options.database.transaction((transaction) =>
    callbackDisposition(transaction, options),
  );
}

export function appendSpawnedSessionReportInTransaction(
  database: SpawnedReportDatabase,
  options: SpawnedReportValues,
): SpawnedReportDisposition | undefined {
  return callbackDisposition(database, options);
}
