import { and, eq, sql } from "drizzle-orm";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { sqliteChangeCount } from "./database-changes.ts";
import { activeSessionCondition } from "./session-store-persistence.ts";

export type SessionToolUpdateStoreResult =
  | { readonly detail: AgentSessionDetail; readonly status: "updated" }
  | { readonly status: "conflict" | "not_found" };

export interface SessionToolUpdateStoreOptions {
  readonly database: AppDatabase;
  readonly read: (
    userId: string,
    sessionId: string,
    workspaceId: string,
  ) => AgentSessionDetail | undefined;
}

/** The tool JSON and generation fence change in the same SQLite statement. */
export function updateStoredSessionTools(
  options: SessionToolUpdateStoreOptions,
  input: {
    readonly expectedGeneration: number;
    readonly now: number;
    readonly sessionId: string;
    readonly tools: readonly AgentSessionToolName[];
    readonly userId: string;
    readonly workspaceId: string;
  },
): SessionToolUpdateStoreResult {
  const existing = options.read(
    input.userId,
    input.sessionId,
    input.workspaceId,
  );
  if (existing === undefined) {
    return { status: "not_found" };
  }

  const endsActiveTurn =
    existing.status === "queued" ||
    existing.status === "running" ||
    existing.status === "paused";
  options.database
    .update(agentSessions)
    .set({
      ...(endsActiveTurn
        ? {
            activeDurationMs: activeSessionDuration(existing, input.now),
            activeStartedAt: null,
            status: "idle" as const,
          }
        : {}),
      executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
      restartHandoff: null,
      tools: JSON.stringify(input.tools),
      ...updatedAuditFields(input.userId, input.now),
    })
    .where(
      and(
        activeSessionCondition({
          id: input.sessionId,
          userId: input.userId,
          workspaceId: input.workspaceId,
        }),
        eq(agentSessions.executionGeneration, input.expectedGeneration),
      ),
    )
    .run();

  const changes = sqliteChangeCount(
    options.database,
    "SQLite did not return the tool update count",
  );
  if (changes === 0) {
    return { status: "conflict" };
  }
  const detail = options.read(input.userId, input.sessionId, input.workspaceId);
  if (detail === undefined) {
    throw new Error("The updated agent session could not be read");
  }
  return { detail, status: "updated" };
}
