import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import {
  activeSessionDuration,
  type SessionTiming,
} from "../shared/session-timing.ts";

export interface SessionFilter {
  readonly id?: string;
  readonly status?: AgentSessionStatus | readonly AgentSessionStatus[];
  readonly userId?: string;
  readonly workspaceId?: string;
}

export interface WorkspaceSessionIdentity {
  readonly sessionId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

interface StoredSessionFilter {
  readonly generation?: number | undefined;
  readonly id?: string | undefined;
  readonly status?:
    AgentSessionStatus | readonly AgentSessionStatus[] | undefined;
  readonly userId?: string | undefined;
  readonly workspaceId?: string | undefined;
}

export function storedSessionCondition(
  filter: StoredSessionFilter,
): SQL | undefined {
  const statusCondition =
    typeof filter.status === "string"
      ? eq(agentSessions.status, filter.status)
      : filter.status === undefined
        ? undefined
        : inArray(agentSessions.status, filter.status);
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
    filter.workspaceId === undefined
      ? undefined
      : eq(agentSessions.workspaceId, filter.workspaceId),
    statusCondition,
    filter.generation === undefined
      ? undefined
      : eq(agentSessions.executionGeneration, filter.generation),
  );
}

export function activeSessionCondition(filter: SessionFilter): SQL | undefined {
  return storedSessionCondition(filter);
}

export function workspaceSessionCondition(
  identity: WorkspaceSessionIdentity,
  generation?: number,
): SQL | undefined {
  return sessionGenerationCondition(
    {
      id: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
    },
    generation,
  );
}

export function runnerReadySessionCondition(
  filter: SessionFilter,
): SQL | undefined {
  return and(
    activeSessionCondition(filter),
    eq(agentSessions.runnerRequired, false),
  );
}

export function sessionGenerationCondition(
  filter: SessionFilter,
  generation?: number,
): SQL | undefined {
  return storedSessionCondition({ ...filter, generation });
}

export function storedParentExecutionGeneration(
  ...parameters: readonly [Pick<AppDatabase, "select">, SQL | undefined]
): number | null | undefined {
  const [database, condition] = parameters;
  const selection = {
    parentExecutionGeneration: agentSessions.parentExecutionGeneration,
  };
  const query = database.select(selection).from(agentSessions);
  return query.where(condition).get()?.parentExecutionGeneration;
}

export function runningCondition(
  sessionId: string,
  userId?: string,
  generation?: number,
): SQL | undefined {
  return storedSessionCondition({
    generation,
    id: sessionId,
    status: "running",
    userId,
  });
}

const SESSION_TIMING_SELECTION = {
  activeDurationMs: agentSessions.activeDurationMs,
  activeStartedAt: agentSessions.activeStartedAt,
};

export interface StoredSessionTiming {
  readonly activeDurationMs: number;
  readonly activeStartedAt: Date | null;
  readonly status?: AgentSessionStatus;
}

export interface StoredSessionSnapshot extends StoredSessionTiming {
  readonly executionGeneration: number;
  readonly id: string;
  readonly interruptedHandoff: string | null;
  readonly restartHandoff: string | null;
  readonly status: AgentSessionStatus;
  readonly userId: string;
}

const STORED_SESSION_SNAPSHOT_SELECTION = {
  ...SESSION_TIMING_SELECTION,
  executionGeneration: agentSessions.executionGeneration,
  id: agentSessions.id,
  interruptedHandoff: agentSessions.interruptedHandoff,
  restartHandoff: agentSessions.restartHandoff,
  status: agentSessions.status,
  userId: agentSessions.userId,
};

export function readStoredSessionSnapshots(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): readonly StoredSessionSnapshot[] {
  return database
    .select(STORED_SESSION_SNAPSHOT_SELECTION)
    .from(agentSessions)
    .where(condition)
    .all();
}

export function storedSessionSnapshotCondition(
  session: StoredSessionSnapshot,
): SQL | undefined {
  return and(
    storedSessionCondition({
      generation: session.executionGeneration,
      id: session.id,
      status: session.status,
      userId: session.userId,
    }),
    session.interruptedHandoff === null
      ? isNull(agentSessions.interruptedHandoff)
      : eq(agentSessions.interruptedHandoff, session.interruptedHandoff),
    session.restartHandoff === null
      ? isNull(agentSessions.restartHandoff)
      : eq(agentSessions.restartHandoff, session.restartHandoff),
  );
}

export function readActiveSessionTiming(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
): StoredSessionTiming | undefined {
  const session = database
    .select(SESSION_TIMING_SELECTION)
    .from(agentSessions)
    .where(condition)
    .get();
  return session?.activeStartedAt == null ? undefined : session;
}

export function sessionTimingUpdate(
  session: SessionTiming<Date | number>,
  now: number,
): {
  readonly activeDurationMs: number;
  readonly activeStartedAt: null;
  readonly stepStartedAt: null;
} {
  return {
    activeDurationMs: activeSessionDuration(session, now),
    activeStartedAt: null,
    stepStartedAt: null,
  };
}

type StoredSessionUpdate = Omit<
  Partial<typeof agentSessions.$inferInsert>,
  "currentSegment" | "executionGeneration"
> & {
  readonly currentSegment?: number | SQL;
  readonly executionGeneration?: number | SQL;
};

export function terminalSessionValues<
  Status extends "completed" | "failed" | "idle",
>(session: StoredSessionTiming, status: Status, now: number) {
  return {
    ...sessionTimingUpdate(session, now),
    interruptedHandoff: null,
    restartHandoff: null,
    status,
    ...updatedAuditFields(SYSTEM_ID, now),
  };
}

export function updateStoredSessions(
  database: Pick<AppDatabase, "update">,
  condition: SQL | undefined,
  values: StoredSessionUpdate,
): boolean {
  return (
    database
      .update(agentSessions)
      .set(values)
      .where(condition)
      .returning({ id: agentSessions.id })
      .all().length > 0
  );
}
