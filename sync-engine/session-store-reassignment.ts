import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { runnerIsAvailable } from "./runner-availability-store.ts";
import { readStoredSessionState } from "./session-store-state.ts";

export const SESSION_TIMING_SELECTION = {
  activeDurationMs: agentSessions.activeDurationMs,
  activeStartedAt: agentSessions.activeStartedAt,
};

export interface StoredSessionTiming {
  readonly activeDurationMs: number;
  readonly activeStartedAt: Date | null;
  readonly status?: AgentSessionStatus;
}

export function sessionTimingUpdate(
  session: StoredSessionTiming,
  now: number,
): { readonly activeDurationMs: number; readonly activeStartedAt: null } {
  return {
    activeDurationMs: activeSessionDuration(session, now),
    activeStartedAt: null,
  };
}

export function updateStoredSession(
  database: Pick<AppDatabase, "update">,
  sessionId: string,
  values: Omit<
    Partial<typeof agentSessions.$inferInsert>,
    "executionGeneration"
  > & { readonly executionGeneration?: number | SQL },
): void {
  database
    .update(agentSessions)
    .set(values)
    .where(eq(agentSessions.id, sessionId))
    .run();
}

export function transitionSessionRunner(
  database: Pick<AppDatabase, "update">,
  session: StoredSessionTiming & { readonly id: string },
  now: number,
): void {
  updateStoredSession(database, session.id, {
    ...sessionTimingUpdate(session, now),
    ...updatedAuditFields(SYSTEM_ID, now),
    executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
    runnerRequired: true,
    status: session.status === "stopped" ? "stopped" : "idle",
  });
}

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

export function sessionGenerationCondition(
  filter: SessionFilter,
  generation?: number,
): SQL | undefined {
  return and(
    activeSessionCondition(filter),
    generation === undefined
      ? undefined
      : eq(agentSessions.executionGeneration, generation),
  );
}

export function runningCondition(
  sessionId: string,
  userId?: string,
  generation?: number,
): SQL | undefined {
  return sessionGenerationCondition(
    {
      id: sessionId,
      status: "running",
      ...(userId === undefined ? {} : { userId }),
    },
    generation,
  );
}

export function didUpdate(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}

export type ReassignSessionResult =
  | { readonly detail: AgentSessionDetail; readonly status: "reassigned" }
  | {
      readonly status:
        "busy" | "not_found" | "not_required" | "runner_unavailable";
    };

export function reassignStoredSession(options: {
  readonly database: AppDatabase;
  readonly now: number;
  readonly read: (
    userId: string,
    sessionId: string,
  ) => AgentSessionDetail | undefined;
  readonly runnerId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly workingDirectory: string;
}): ReassignSessionResult {
  const ownedSession = activeSessionCondition({
    id: options.sessionId,
    userId: options.userId,
  });
  const status = options.database.transaction((transaction) => {
    const stored = readStoredSessionState(transaction, ownedSession);

    if (stored === undefined) {
      return "not_found" as const;
    }
    if (stored.status === "queued" || stored.status === "running") {
      return "busy" as const;
    }
    if (!stored.runnerRequired) {
      return "not_required" as const;
    }

    if (
      !runnerIsAvailable(
        transaction,
        options.userId,
        options.runnerId,
        options.now,
      )
    ) {
      return "runner_unavailable" as const;
    }

    transaction
      .update(agentSessions)
      .set({
        runnerId: options.runnerId,
        runnerRequired: false,
        executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
        workingDirectory: options.workingDirectory,
        ...updatedAuditFields(options.userId, options.now),
      })
      .where(ownedSession)
      .run();
    return "reassigned" as const;
  });

  if (status !== "reassigned") {
    return { status };
  }
  const detail = options.read(options.userId, options.sessionId);
  if (detail === undefined) {
    throw new Error("The reassigned agent session could not be read");
  }
  return { detail, status };
}

export function interruptedStoredSessions(database: AppDatabase): readonly {
  readonly activeDurationMs: number;
  readonly activeStartedAt: Date | null;
  readonly id: string;
  readonly userId: string;
}[] {
  return database
    .select({
      ...SESSION_TIMING_SELECTION,
      id: agentSessions.id,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.isDeleted, false),
        inArray(agentSessions.status, ["queued", "running"]),
      ),
    )
    .all();
}

export function transitionStoredSession(options: {
  readonly actorId: string;
  readonly database: AppDatabase;
  readonly from: readonly AgentSessionStatus[];
  readonly generation?: number;
  readonly now: number;
  readonly sessionId: string;
  readonly to: AgentSessionStatus;
  readonly userId?: string;
}): boolean {
  return didUpdate(
    options.database
      .update(agentSessions)
      .set({
        status: options.to,
        ...updatedAuditFields(options.actorId, options.now),
      })
      .where(
        and(
          activeSessionCondition({
            id: options.sessionId,
            ...(options.userId === undefined ? {} : { userId: options.userId }),
          }),
          inArray(agentSessions.status, options.from),
          options.generation === undefined
            ? undefined
            : eq(agentSessions.executionGeneration, options.generation),
        ),
      )
      .returning({ updatedAt: agentSessions.updatedAt })
      .all(),
  );
}
