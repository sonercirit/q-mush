import { sql } from "drizzle-orm";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionTimingUpdate,
  workspaceSessionCondition,
} from "./session-store-persistence.ts";
import { updateSessionAndEndGenerationTurn } from "./session-turn-store.ts";

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
  const changed = options.database.transaction((transaction) =>
    updateSessionAndEndGenerationTurn({
      condition: workspaceSessionCondition(input, input.expectedGeneration),
      database: transaction,
      generation: input.expectedGeneration,
      now: input.now,
      sessionId: input.sessionId,
      values: {
        ...(endsActiveTurn
          ? {
              status: "idle" as const,
              ...sessionTimingUpdate(existing, input.now),
            }
          : {}),
        executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
        interruptedHandoff: null,
        restartHandoff: null,
        tools: JSON.stringify(input.tools),
        ...updatedAuditFields(input.userId, input.now),
      },
    }),
  );

  if (!changed) {
    return { status: "conflict" };
  }
  const detail = options.read(input.userId, input.sessionId, input.workspaceId);
  if (detail === undefined) {
    throw new Error("The updated agent session could not be read");
  }
  return { detail, status: "updated" };
}
