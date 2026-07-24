import { and, eq, inArray, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export type StoredSessionReader = (
  userId: string,
  sessionId: string,
) => AgentSessionDetail | undefined;

export interface StoredSessionDetail {
  readonly detail: AgentSessionDetail;
  readonly userId: string;
}

export interface StoredSessionIdentity {
  readonly id: string;
  readonly userId: string;
}

type SessionStatus = (typeof agentSessions.$inferSelect)["status"];

function activeSessionStatuses(
  statuses: readonly SessionStatus[],
  additionalCondition?: SQL,
): SQL | undefined {
  return and(
    additionalCondition,
    eq(agentSessions.isDeleted, false),
    inArray(agentSessions.status, statuses),
  );
}

function sessionIdentitySelection() {
  return { id: agentSessions.id, userId: agentSessions.userId };
}

function selectSessionIdentities(
  database: AppDatabase,
  condition: SQL | undefined,
): readonly StoredSessionIdentity[] {
  return database
    .select(sessionIdentitySelection())
    .from(agentSessions)
    .where(condition)
    .all();
}

export function interruptedSessionRows(database: AppDatabase) {
  return database
    .select({
      activeDurationMs: agentSessions.activeDurationMs,
      activeStartedAt: agentSessions.activeStartedAt,
      ...sessionIdentitySelection(),
    })
    .from(agentSessions)
    .where(activeSessionStatuses(["queued", "running"]))
    .all();
}

export function sessionRowsWithStatus(
  database: AppDatabase,
  statuses: readonly SessionStatus[],
  additionalCondition?: SQL,
): readonly StoredSessionIdentity[] {
  return selectSessionIdentities(
    database,
    activeSessionStatuses(statuses, additionalCondition),
  );
}

export function readStoredSessionDetails(
  rows: readonly StoredSessionIdentity[],
  read: StoredSessionReader,
): readonly StoredSessionDetail[] {
  return rows.flatMap(({ id, userId }) => {
    const detail = read(userId, id);
    return detail === undefined ? [] : [{ detail, userId }];
  });
}

export function activeRunnerSessions(
  database: AppDatabase,
  runnerId: string,
  read: StoredSessionReader,
): readonly StoredSessionDetail[] {
  const rows = sessionRowsWithStatus(
    database,
    ["queued", "running"],
    eq(agentSessions.runnerId, runnerId),
  );
  return readStoredSessionDetails(rows, read);
}
