import { and, eq, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { IdGenerator } from "../shared/ids.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";
import { readStoredSessionGenerationTranscript } from "./session-generation-transcript.ts";
import { retireManualCompactionOperations } from "./session-manual-compaction-query.ts";
import { spawnedSessionReport } from "./session-spawn-report.ts";
import {
  type StoredSessionUpdate,
  updateStoredSessions,
} from "./session-store-persistence.ts";
import {
  appendSpawnedSessionReportInTransaction,
  type SpawnedReportDisposition,
} from "./session-store-spawns.ts";
import {
  endGenerationSessionTurn,
  rotateSessionTurn,
} from "./session-turn-store.ts";

export type SessionGenerationAdvanceMode = "administrative" | "attempt";

type GenerationAdvanceDatabase = Pick<
  AppDatabase,
  "insert" | "select" | "update"
>;

interface GenerationAdvanceState {
  readonly currentSegment: number;
  readonly executionGeneration: number;
  readonly id: string;
  readonly parentExecutionGeneration: number | null;
  readonly parentReportedGeneration: number;
  readonly parentSessionId: string | null;
  readonly status: AgentSessionStatus;
  readonly userId: string;
}

interface StartGenerationTurn {
  readonly id?: string;
  readonly startedAt?: number;
}

export interface SessionGenerationAdvanceResult {
  readonly generation: number;
  readonly userId: string;
  readonly reportedParent?: {
    readonly disposition: SpawnedReportDisposition;
    readonly id: string;
  };
  readonly turnId?: string;
}

interface SessionGenerationAdvanceOptions {
  readonly condition: SQL | undefined;
  readonly database: GenerationAdvanceDatabase;
  readonly generateId: IdGenerator;
  readonly mode: SessionGenerationAdvanceMode;
  readonly now: number;
  readonly sessionId: string;
  readonly startTurn?: StartGenerationTurn;
  readonly values: StoredSessionUpdate;
}

function advanceState(
  database: Pick<AppDatabase, "select">,
  condition: SQL | undefined,
  sessionId: string,
): GenerationAdvanceState | undefined {
  return database
    .select({
      currentSegment: agentSessions.currentSegment,
      executionGeneration: agentSessions.executionGeneration,
      id: agentSessions.id,
      parentExecutionGeneration: agentSessions.parentExecutionGeneration,
      parentReportedGeneration: agentSessions.parentReportedGeneration,
      parentSessionId: agentSessions.parentSessionId,
      status: agentSessions.status,
      userId: agentSessions.userId,
    })
    .from(agentSessions)
    .where(and(condition, eq(agentSessions.id, sessionId)))
    .get();
}

function reportTerminalGeneration(
  options: SessionGenerationAdvanceOptions,
  state: GenerationAdvanceState,
): {
  readonly disposition?: SpawnedReportDisposition;
  readonly parentId?: string;
  readonly status: "blocked" | "ready";
} {
  const parentId = state.parentSessionId;
  const parentGeneration = state.parentExecutionGeneration;
  if (
    parentId === null ||
    parentGeneration === null ||
    state.parentReportedGeneration >= state.executionGeneration ||
    (state.status !== "completed" &&
      state.status !== "failed" &&
      state.status !== "stopped")
  ) {
    return { status: "ready" };
  }
  const transcript = readStoredSessionGenerationTranscript(
    options.database,
    state.id,
    state.executionGeneration,
  );
  const report = spawnedSessionReport(
    {
      generation: state.executionGeneration,
      id: state.id,
      messages: transcript.messages,
      status: state.status,
      turns: transcript.turns,
    },
    parentId,
  );
  if (report === undefined) {
    return { status: "blocked" };
  }
  const disposition = appendSpawnedSessionReportInTransaction(
    options.database,
    {
      childGeneration: state.executionGeneration,
      childId: state.id,
      content: report.content,
      generateId: options.generateId,
      now: options.now,
      parentGeneration,
      parentId,
      userId: state.userId,
    },
  );
  return disposition === undefined
    ? { status: "blocked" }
    : { disposition, parentId, status: "ready" };
}

function nextGeneration(current: number): number | undefined {
  const next = current + 1;
  return Number.isSafeInteger(next) && next >= 0 ? next : undefined;
}

/**
 * Advances the execution fence and its parent-report ledger atomically.
 * Attempt advances make only the successor reportable. Administrative advances
 * make the successor non-reportable after persisting any pending terminal event.
 */
export function advanceStoredSessionGeneration(
  options: SessionGenerationAdvanceOptions,
): SessionGenerationAdvanceResult | undefined {
  const state = advanceState(
    options.database,
    options.condition,
    options.sessionId,
  );
  const generation =
    state === undefined ? undefined : nextGeneration(state.executionGeneration);
  if (state === undefined || generation === undefined) {
    return undefined;
  }
  const report = reportTerminalGeneration(options, state);
  if (report.status === "blocked") {
    return undefined;
  }
  const reportedGeneration =
    options.mode === "attempt" ? state.executionGeneration : generation;
  if (
    !updateStoredSessions(
      options.database,
      and(
        options.condition,
        eq(agentSessions.id, state.id),
        eq(agentSessions.executionGeneration, state.executionGeneration),
      ),
      {
        ...options.values,
        executionGeneration: generation,
        parentReportedGeneration: reportedGeneration,
      },
    )
  ) {
    return undefined;
  }

  let turnId: string | undefined;
  if (options.startTurn === undefined) {
    retireManualCompactionOperations(
      options.database,
      state.id,
      state.executionGeneration,
      options.now,
      "through",
    );
    endGenerationSessionTurn(
      options.database,
      state.id,
      state.executionGeneration,
      options.now,
    );
  } else {
    turnId = rotateSessionTurn({
      database: options.database,
      executionGeneration: generation,
      generateId: options.generateId,
      ...(options.startTurn.id === undefined
        ? {}
        : { id: options.startTurn.id }),
      now: options.now,
      previousExecutionGeneration: state.executionGeneration,
      segment: state.currentSegment,
      sessionId: state.id,
      ...(options.startTurn.startedAt === undefined
        ? {}
        : { startedAt: options.startTurn.startedAt }),
      userId: state.userId,
    });
  }
  return {
    generation,
    userId: state.userId,
    ...(report.parentId === undefined || report.disposition === undefined
      ? {}
      : {
          reportedParent: {
            disposition: report.disposition,
            id: report.parentId,
          },
        }),
    ...(turnId === undefined ? {} : { turnId }),
  };
}
