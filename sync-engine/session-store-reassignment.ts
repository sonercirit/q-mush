import { sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { SYSTEM_ID } from "../shared/ids.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
} from "../shared/session-model.ts";
import { runnerIsAvailable } from "./runner-availability-store.ts";
import {
  activePendingInput,
  settleNormalSessionBoundary,
} from "./session-pending-inputs.ts";
import { parseRestartHandoff } from "./session-restart-store.ts";
import {
  activeSessionCondition,
  readStoredSessionSnapshots,
  storedSessionCondition,
  terminalSessionValues,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";
import { readStoredSessionState } from "./session-store-state.ts";
import {
  errorMessageValues,
  insertStoredMessage,
  interruptedSessionErrorValues,
} from "./session-store-values.ts";
import { recoverStoredTerminal } from "./session-terminal-store.ts";
import {
  updateSessionAndEndGenerationTurn,
  updateStoredSnapshotAndEndGenerationTurn,
} from "./session-turn-store.ts";

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
    if (
      stored.status === "queued" ||
      stored.status === "running" ||
      stored.status === "paused"
    ) {
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

    if (
      !updateSessionAndEndGenerationTurn({
        condition: ownedSession,
        database: transaction,
        generation: stored.executionGeneration,
        now: options.now,
        sessionId: options.sessionId,
        values: {
          runnerId: options.runnerId,
          runnerRequired: false,
          executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
          workingDirectory: options.workingDirectory,
          ...updatedAuditFields(options.userId, options.now),
        },
      })
    ) {
      throw new Error("The agent session changed during reassignment");
    }
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

export interface InterruptedStoredSession extends StoredSessionSnapshot {
  readonly status: Extract<AgentSessionStatus, "queued" | "running">;
}

export function interruptedStoredSessions(
  database: AppDatabase,
  now: number,
): readonly InterruptedStoredSession[] {
  const stored = readStoredSessionSnapshots(
    database,
    storedSessionCondition({ status: ["queued", "running"] as const }),
  );
  const sessions: InterruptedStoredSession[] = [];
  for (const session of stored) {
    const { status } = session;
    if (status !== "queued" && status !== "running") {
      throw new Error("An interrupted stored session has an invalid status");
    }
    const interrupted = { ...session, status };
    if (parseRestartHandoff(session.restartHandoff) !== null) {
      sessions.push(interrupted);
      continue;
    }
    if (session.status === "queued" && session.restartHandoff === null) {
      continue;
    }
    if (recoverStoredTerminal(database, session, now)) {
      continue;
    }
    if (
      session.status === "running" &&
      activePendingInput(database, session.id) !== undefined &&
      settleNormalSessionBoundary({
        database,
        generation: session.executionGeneration,
        now,
        sessionId: session.id,
      }).status === "queued"
    ) {
      continue;
    }
    sessions.push(interrupted);
  }
  return sessions;
}

export function failInterruptedStoredSession(
  database: AppDatabase,
  session: InterruptedStoredSession,
  messageId: string,
  now: number,
  error?: string,
): boolean {
  return database.transaction((transaction) => {
    const updated = updateStoredSnapshotAndEndGenerationTurn(
      transaction,
      session,
      now,
      terminalSessionValues(session, "failed", now),
    );
    if (!updated) {
      return false;
    }
    insertStoredMessage(
      transaction,
      error === undefined
        ? interruptedSessionErrorValues()
        : errorMessageValues(error),
      {
        actorId: SYSTEM_ID,
        id: messageId,
        now,
        sessionId: session.id,
        userId: session.userId,
      },
    );
    return true;
  });
}
