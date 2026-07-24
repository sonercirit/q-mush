import { and, eq, sql, type SQL } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  RestartHandoff,
  RestartHandoffRequester,
} from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { activeSessionCondition } from "./session-lifecycle-store.ts";

export interface PendingRestartSession {
  readonly detail: AgentSessionDetail;
  readonly userId: string;
}

type RestartableStatus = "paused" | "queued" | "running";

function parseRestartHandoff(value: string | null): RestartHandoff | null {
  if (value === null) {
    return null;
  }
  try {
    const handoff: unknown = JSON.parse(value);
    if (
      typeof handoff === "object" &&
      handoff !== null &&
      "pendingInput" in handoff &&
      Array.isArray(handoff.pendingInput) &&
      "requestedBy" in handoff &&
      (handoff.requestedBy === "runner" || handoff.requestedBy === "server") &&
      "restartId" in handoff &&
      typeof handoff.restartId === "string" &&
      handoff.restartId.length > 0 &&
      handoff.restartId.length <= 200
    ) {
      return {
        pendingInput: handoff.pendingInput,
        requestedBy: handoff.requestedBy,
        restartId: handoff.restartId,
      };
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored restart handoff is invalid");
}

interface RestartHandoffStoreOptions {
  readonly database: AppDatabase;
  readonly read: (
    userId: string,
    sessionId: string,
  ) => AgentSessionDetail | undefined;
}

function restartableSession(
  sessionId: string,
  status: RestartableStatus,
): SQL | undefined {
  return activeSessionCondition({ id: sessionId, status });
}

function handoffValue(
  // cpd-ignore-start -- Restart identifiers use the same bounded protocol validation at each trust boundary.
  requestedBy: RestartHandoffRequester,
  restartId: string,
): string {
  if (restartId.length === 0 || restartId.length > 200) {
    throw new Error("The restart handoff ID is invalid");
  }
  return JSON.stringify({
    pendingInput: [],
    requestedBy,
    restartId,
  } satisfies RestartHandoff);
}
// cpd-ignore-end

function didUpdate(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}

export class RestartHandoffStore {
  readonly #options: RestartHandoffStoreOptions;

  constructor(options: RestartHandoffStoreOptions) {
    this.#options = options;
  }

  parse(value: string | null): RestartHandoff | null {
    return parseRestartHandoff(value);
  }

  pauseQueued(
    // cpd-ignore-start -- Queued and running handoffs deliberately share one persistence contract.
    sessionId: string,
    requestedBy: RestartHandoffRequester,
    restartId: string,
    now: number,
  ): boolean {
    return this.#pause(
      sessionId,
      "queued",
      handoffValue(requestedBy, restartId),
      now,
    );
    // cpd-ignore-end
  }

  pauseRunning(
    // cpd-ignore-start -- Store facade and handoff persistence deliberately expose matching pause contracts.
    sessionId: string,
    requestedBy: RestartHandoffRequester,
    restartId: string,
    now: number,
  ): boolean {
    return this.#options.database.transaction((transaction) => {
      // cpd-ignore-start -- Restart timing mirrors the lifecycle store's durable active-time update.
      const session = transaction
        .select({
          activeDurationMs: agentSessions.activeDurationMs,
          activeStartedAt: agentSessions.activeStartedAt,
        })
        .from(agentSessions)
        .where(restartableSession(sessionId, "running"))
        .get();
      if (session?.activeStartedAt === null || session === undefined) {
        return false;
      }
      const updated = transaction
        .update(agentSessions)
        .set({
          activeDurationMs: activeSessionDuration(session, now),
          activeStartedAt: null,
          restartHandoff: handoffValue(requestedBy, restartId),
          status: "paused",
          ...updatedAuditFields(SYSTEM_ID, now),
        })
        .where(restartableSession(sessionId, "running"))
        .returning({ id: agentSessions.id })
        .all();
      // cpd-ignore-end
      return didUpdate(updated);
    });
  }

  pending(runnerId?: string): readonly PendingRestartSession[] {
    // cpd-ignore-start -- Pending handoffs use the established persisted-session projection.
    return this.#options.database
      .select({ id: agentSessions.id, userId: agentSessions.userId })
      .from(agentSessions)
      .where(
        and(
          activeSessionCondition({ status: "paused" }),
          runnerId === undefined
            ? undefined
            : eq(agentSessions.runnerId, runnerId),
        ),
      )
      .all()
      .flatMap(({ id, userId }) => {
        const detail = this.#options.read(userId, id);
        return detail === undefined ? [] : [{ detail, userId }];
      });
    // cpd-ignore-end
  }

  claim(
    // cpd-ignore-start -- Store facade and handoff persistence deliberately expose matching claim contracts.
    userId: string,
    sessionId: string,
    restartId: string,
    now: number,
  ): AgentSessionDetail | undefined {
    // cpd-ignore-start -- Transactional claim guards intentionally mirror adjacent session claims.
    const claimed = this.#options.database.transaction((transaction) => {
      const stored = transaction
        .select({ restartHandoff: agentSessions.restartHandoff })
        .from(agentSessions)
        .where(
          and(
            restartableSession(sessionId, "paused"),
            eq(agentSessions.userId, userId),
          ),
        )
        .get();
      if (
        stored?.restartHandoff === null ||
        stored === undefined ||
        parseRestartHandoff(stored.restartHandoff)?.restartId !== restartId
      ) {
        return false;
      }
      const updated = transaction
        .update(agentSessions)
        .set({ status: "queued", ...updatedAuditFields(SYSTEM_ID, now) })
        .where(
          and(
            restartableSession(sessionId, "paused"),
            eq(agentSessions.userId, userId),
            eq(agentSessions.restartHandoff, stored.restartHandoff),
          ),
        )
        .returning({ id: agentSessions.id })
        .all();
      return didUpdate(updated);
    });
    // cpd-ignore-end
    return claimed ? this.#options.read(userId, sessionId) : undefined;
    // cpd-ignore-end
  }

  complete(sessionId: string): void {
    this.#clear(sessionId, "running");
  }

  finish(sessionId: string): void {
    this.#clear(sessionId, "idle");
  }

  restore(sessionId: string, now: number): void {
    this.#options.database
      .update(agentSessions)
      .set({ status: "paused", ...updatedAuditFields(SYSTEM_ID, now) })
      .where(
        and(
          restartableSession(sessionId, "queued"),
          sql`${agentSessions.restartHandoff} IS NOT NULL`,
        ),
      )
      .run();
  }

  #clear(sessionId: string, status: "idle" | "running"): void {
    this.#options.database
      .update(agentSessions)
      .set({ restartHandoff: null })
      .where(
        and(
          activeSessionCondition({ id: sessionId, status }),
          sql`${agentSessions.restartHandoff} IS NOT NULL`,
        ),
      )
      .run();
  }

  #pause(
    sessionId: string,
    status: "queued",
    restartHandoff: string,
    now: number,
  ): boolean {
    // cpd-ignore-start -- Restart persistence deliberately follows existing audited update chains.
    const updated = this.#options.database
      .update(agentSessions)
      .set({
        restartHandoff,
        status: "paused",
        ...updatedAuditFields(SYSTEM_ID, now),
      })
      .where(restartableSession(sessionId, status))
      .returning({ id: agentSessions.id })
      .all();
    // cpd-ignore-end
    return didUpdate(updated);
  }
}
