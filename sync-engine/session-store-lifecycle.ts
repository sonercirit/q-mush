import { and, inArray } from "drizzle-orm";
import { readAgentFile, type AgentFile } from "../shared/agent-file.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import {
  activeSessionCondition,
  runningCondition,
} from "./session-store-selection.ts";

const SESSION_TIMING_SELECTION = {
  activeDurationMs: agentSessions.activeDurationMs,
  activeStartedAt: agentSessions.activeStartedAt,
};

function didUpdate(rows: readonly unknown[]): boolean {
  return rows.length > 0;
}

// cpd-ignore-start -- Lifecycle queries deliberately mirror guarded store transitions.
function transition(options: {
  readonly actorId: string;
  readonly database: AppDatabase;
  readonly from: readonly AgentSessionStatus[];
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
        ),
      )
      .returning({ updatedAt: agentSessions.updatedAt })
      .all(),
  );
}

export function readStoredAgentFile(
  database: AppDatabase,
  sessionId: string,
): AgentFile | null {
  const stored = database
    .select({
      content: agentSessions.agentFileContent,
      name: agentSessions.agentFileName,
    })
    .from(agentSessions)
    .where(activeSessionCondition({ id: sessionId }))
    .get();
  if (stored === undefined) {
    throw new Error("The agent session no longer exists");
  }
  return readAgentFile(
    stored.content === null && stored.name === null ? null : stored,
  );
}

export function startActiveSession(
  database: AppDatabase,
  sessionId: string,
  now: number,
): boolean {
  return didUpdate(
    database
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

export function finishActiveSession(options: {
  readonly actorId: string;
  readonly database: AppDatabase;
  readonly now: number;
  readonly sessionId: string;
  readonly status: "failed" | "idle" | "stopped";
  readonly userId?: string;
}): boolean {
  const session = options.database
    .select(SESSION_TIMING_SELECTION)
    .from(agentSessions)
    .where(runningCondition(options.sessionId, options.userId))
    .get();
  if (session?.activeStartedAt === null || session === undefined) {
    return false;
  }
  return didUpdate(
    options.database
      .update(agentSessions)
      .set({
        activeDurationMs: activeSessionDuration(session, options.now),
        activeStartedAt: null,
        status: options.status,
        ...updatedAuditFields(options.actorId, options.now),
      })
      .where(runningCondition(options.sessionId, options.userId))
      .returning({ status: agentSessions.status })
      .all(),
  );
}

export function systemTransition(options: {
  readonly database: AppDatabase;
  readonly from: readonly AgentSessionStatus[];
  readonly now: number;
  readonly sessionId: string;
  readonly to: AgentSessionStatus;
}): boolean {
  return transition({ ...options, actorId: SYSTEM_ID });
}

export function userTransition(options: {
  readonly database: AppDatabase;
  readonly from: readonly AgentSessionStatus[];
  readonly now: number;
  readonly sessionId: string;
  readonly to: AgentSessionStatus;
  readonly userId: string;
}): boolean {
  return transition({ ...options, actorId: options.userId });
}
// cpd-ignore-end
