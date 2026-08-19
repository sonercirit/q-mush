import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { isTruncationNotice } from "../shared/agent-loop.ts";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import {
  normalSessionCompletionStatus,
  type RestartHandoff,
} from "../shared/session-model.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import {
  activePendingInput,
  promotePendingInput,
} from "./session-pending-inputs.ts";
import { canonicalRestartHandoff } from "./session-restart-store.ts";
import {
  runningCondition,
  sessionTimingUpdate,
  storedParentExecutionGeneration,
  storedSessionSnapshotCondition,
  terminalSessionValues,
  updateStoredSessions,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";
import {
  endGenerationSessionTurn,
  rotateSessionTurn,
  updateStoredSnapshotAndEndGenerationTurn,
} from "./session-turn-store.ts";

export interface RuntimeTerminalTarget {
  readonly generation: number;
  readonly restartHandoff: RestartHandoff | null;
  readonly sessionId: string;
}

export function terminalRuntimeCondition(
  target: RuntimeTerminalTarget,
): SQL | undefined {
  return and(
    runningCondition(target.sessionId, undefined, target.generation),
    target.restartHandoff === null
      ? isNull(agentSessions.restartHandoff)
      : eq(
          agentSessions.restartHandoff,
          canonicalRestartHandoff(target.restartHandoff),
        ),
  );
}

export function settleTerminalRuntime(
  database: Pick<AppDatabase, "insert" | "select" | "update">,
  condition: SQL | undefined,
  status: "completed" | "failed" | "idle",
  now: number,
  sessionId?: string,
): "completed" | "failed" | "idle" | "queued" {
  const session = database
    .select({
      activeDurationMs: agentSessions.activeDurationMs,
      activeStartedAt: agentSessions.activeStartedAt,
      currentSegment: agentSessions.currentSegment,
      executionGeneration: agentSessions.executionGeneration,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(condition)
    .get();
  if (session?.activeStartedAt === null || session === undefined) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
  const pending =
    status !== "failed" && sessionId !== undefined
      ? activePendingInput(database, sessionId)
      : undefined;
  const successorTurnId =
    pending !== undefined && sessionId !== undefined
      ? rotateSessionTurn({
          database,
          executionGeneration: session.executionGeneration,
          generateId: () => `${sessionId}:${String(now)}`,
          now,
          previousExecutionGeneration: session.executionGeneration,
          segment: session.currentSegment,
          sessionId,
          userId: session.userId,
        })
      : undefined;
  if (
    pending !== undefined &&
    sessionId !== undefined &&
    successorTurnId !== undefined
  ) {
    promotePendingInput(
      database,
      pending,
      session.userId,
      now,
      session.currentSegment,
      successorTurnId,
    );
  }
  const settledStatus = pending === undefined ? status : "queued";
  const values =
    settledStatus === "queued"
      ? {
          ...sessionTimingUpdate(session, now),
          interruptedHandoff: null,
          restartHandoff: null,
          status: "queued" as const,
          ...updatedAuditFields(SYSTEM_ID, now),
        }
      : terminalSessionValues(session, status, now);
  if (!updateStoredSessions(database, condition, values)) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
  if (sessionId !== undefined) {
    retireManualCompactionOperations(
      database,
      sessionId,
      session.executionGeneration,
      now,
      "through",
    );
    if (settledStatus !== "queued") {
      endGenerationSessionTurn(
        database,
        sessionId,
        session.executionGeneration,
        now,
      );
    }
  }
  return settledStatus;
}

// The persisted handoff must keep starting with this prefix: terminal
// recovery matches it, and session-compaction.ts builds the message.
export const COMPACTION_MESSAGE_PREFIX = "Conversation compacted:\n\n";

function storedTerminalExists(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): boolean {
  const latest = database
    .select({
      content: agentMessages.content,
      isDeleted: agentMessages.isDeleted,
      role: agentMessages.role,
      toolCalls: agentMessages.toolCalls,
    })
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, sessionId))
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
    .all();
  const activeRows = latest.filter(({ isDeleted }) => !isDeleted);
  // A truncated terminal step persists its assistant answer plus a trailing
  // truncation notice; the pair is just as settled as a bare assistant row.
  const active =
    activeRows[0]?.role === "error" && isTruncationNotice(activeRows[0].content)
      ? activeRows[1]
      : activeRows[0];
  if (active?.role === "assistant") {
    try {
      const calls: unknown = JSON.parse(active.toolCalls ?? "null");
      return Array.isArray(calls) && calls.length === 0;
    } catch {
      return false;
    }
  }
  // Sessions compacted before transcript steps were persisted (PR #166) end
  // with the handoff user message as the latest active row; current
  // compactions settle through the assistant branch above.
  return (
    active?.role === "user" &&
    active.content.startsWith(COMPACTION_MESSAGE_PREFIX) &&
    latest.some(({ isDeleted }) => isDeleted)
  );
}

export function recoverStoredTerminal(
  database: AppDatabase,
  session: StoredSessionSnapshot,
  now: number,
): boolean {
  const settle = (
    transaction: Pick<AppDatabase, "insert" | "select" | "update">,
  ): boolean => {
    const parentExecutionGeneration = storedParentExecutionGeneration(
      transaction,
      storedSessionSnapshotCondition(session),
    );
    return (
      storedTerminalExists(transaction, session.id) &&
      updateStoredSnapshotAndEndGenerationTurn(
        transaction,
        session,
        now,
        terminalSessionValues(
          session,
          normalSessionCompletionStatus({ parentExecutionGeneration }),
          now,
        ),
      )
    );
  };
  return database.transaction(settle);
}
