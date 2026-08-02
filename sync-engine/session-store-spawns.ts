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
  storedSystemMessageValues,
  storedUserMessageValues,
} from "./session-store-values.ts";

type TerminalParentStatus = "completed" | "failed" | "idle" | "stopped";

const TERMINAL_PARENT_CALLBACK_NOTE =
  "Completion callback was not delivered because the parent session was already terminal";

function terminalParentCallbackNote(status: TerminalParentStatus): string {
  return `${TERMINAL_PARENT_CALLBACK_NOTE} (${status}).`;
}

function parentIsTerminal(
  status: (typeof REPORTABLE_PARENT_STATUSES)[number],
): status is TerminalParentStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "idle" ||
    status === "stopped"
  );
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

export type SpawnedReportDisposition = "delivered" | "promoted" | "terminal";

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

const REPORTABLE_CHILD_STATUSES = ["completed", "failed", "stopped"] as const;

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
          status: REPORTABLE_CHILD_STATUSES,
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
  sessionId = options.parentId,
) {
  return {
    database,
    generateId: options.generateId,
    now: options.now,
    sessionId,
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
}): SpawnedReportDisposition | undefined {
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
    );
    if (
      !updateStoredSessions(transaction, childCondition, {
        parentExecutionGeneration: null,
      })
    ) {
      return undefined;
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
          return undefined;
        }
        break;
      case "completed":
      case "failed":
      case "idle":
      case "stopped":
        appendSystemStoredMessage({
          ...reportMessageOptions(options, transaction, options.childId),
          message: storedSystemMessageValues(
            terminalParentCallbackNote(parent.status),
          ),
        });
        break;
      case "paused":
      case "queued":
        appendSystemStoredMessage({
          ...reportMessageOptions(options, transaction),
          message: storedUserMessageValues(options.content),
        });
        break;
    }

    const terminal = parentIsTerminal(parent.status);
    const reportedSessionId = terminal ? options.childId : options.parentId;
    transaction
      .update(agentSessions)
      .set({
        updatedAt: new Date(options.now),
        updatedById: SYSTEM_ID,
      })
      .where(
        storedSessionCondition({
          id: reportedSessionId,
          userId: options.userId,
        }),
      )
      .run();
    if (terminal) return "terminal";
    return parent.status === "running" ? "promoted" : "delivered";
  });
}
