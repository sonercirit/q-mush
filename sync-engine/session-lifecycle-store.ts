import { and, eq, inArray, type SQL } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  AgentSessionCostBasis,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";

export interface SessionFilter {
  readonly id?: string;
  readonly status?: AgentSessionStatus;
  readonly userId?: string;
}

export function activeSessionCondition(filter: SessionFilter): SQL | undefined {
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.status === undefined
      ? undefined
      : eq(agentSessions.status, filter.status),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
  );
}

function runningCondition(sessionId: string, userId?: string): SQL | undefined {
  // cpd-ignore-start -- Lifecycle and handoff stores share authoritative conditions and update checks.
  return activeSessionCondition({
    id: sessionId,
    status: "running",
    ...(userId === undefined ? {} : { userId }),
  });
}

function didUpdate(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}
// cpd-ignore-end

interface SessionLifecycleStoreOptions {
  readonly database: AppDatabase;
}

export class SessionLifecycleStore {
  readonly #database: AppDatabase;

  constructor(options: SessionLifecycleStoreOptions) {
    this.#database = options.database;
  }

  updateRunning(
    // cpd-ignore-start -- Audited lifecycle writes intentionally mirror adjacent store operations.
    sessionId: string,
    values: Omit<
      Partial<typeof agentSessions.$inferInsert>,
      "costBasis" | "costUsd"
    > & {
      readonly costBasis?: AgentSessionCostBasis | SQL;
      readonly costUsd?: number | SQL;
    },
    now: number,
  ): void {
    this.#database
      .update(agentSessions)
      .set({ ...values, ...updatedAuditFields(SYSTEM_ID, now) })
      .where(runningCondition(sessionId))
      .run();
  }
  // cpd-ignore-end

  mark(
    // cpd-ignore-start -- The facade and lifecycle store deliberately expose the same mark contract.
    sessionId: string,
    status: "failed" | "idle" | "running",
    now: number,
  ): boolean {
    switch (status) {
      case "failed":
        return (
          this.finishActive(sessionId, "failed", now) ||
          this.transition(sessionId, ["queued"], status, SYSTEM_ID, now)
        );
      case "idle":
        return this.finishActive(sessionId, "idle", now);
      case "running":
        return didUpdate(
          this.#database
            .update(agentSessions)
            .set({
              activeStartedAt: new Date(now),
              status: "running",
              ...updatedAuditFields(SYSTEM_ID, now),
            })
            .where(activeSessionCondition({ id: sessionId, status: "queued" }))
            .returning()
            .all(),
        );
    }
  }
  // cpd-ignore-end

  stop(userId: string, sessionId: string, now: number): boolean {
    if (this.finishActive(sessionId, "stopped", now, userId, userId)) {
      return true;
    }
    return this.transition(
      sessionId,
      ["queued", "running", "paused", "idle", "failed"],
      "stopped",
      userId,
      now,
      userId,
    );
  }

  finishActive(
    sessionId: string,
    status: "failed" | "idle" | "stopped",
    now: number,
    actorId: string = SYSTEM_ID,
    userId?: string,
  ): boolean {
    const session = this.#database
      .select({
        activeDurationMs: agentSessions.activeDurationMs,
        activeStartedAt: agentSessions.activeStartedAt,
      })
      .from(agentSessions)
      .where(runningCondition(sessionId, userId))
      .get();
    if (session?.activeStartedAt === null || session === undefined) {
      return false;
    }
    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          activeDurationMs: activeSessionDuration(session, now),
          activeStartedAt: null,
          status,
          ...updatedAuditFields(actorId, now),
        })
        .where(runningCondition(sessionId, userId))
        .returning({ status: agentSessions.status })
        .all(),
    );
  }

  transition(
    sessionId: string,
    from: readonly AgentSessionStatus[],
    to: AgentSessionStatus,
    actorId: string,
    now: number,
    userId?: string,
  ): boolean {
    return didUpdate(
      this.#database
        .update(agentSessions)
        .set({
          restartHandoff: null,
          status: to,
          ...updatedAuditFields(actorId, now),
        })
        .where(
          and(
            activeSessionCondition({
              id: sessionId,
              ...(userId === undefined ? {} : { userId }),
            }),
            inArray(agentSessions.status, from),
          ),
        )
        .returning({ updatedAt: agentSessions.updatedAt })
        .all(),
    );
  }
}
