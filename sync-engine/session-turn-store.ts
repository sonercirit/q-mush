import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import { createdAuditFields, updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import {
  agentMessages,
  agentSessions,
  agentSessionTurns,
} from "../shared/database/schema.ts";
import { SYSTEM_ID, type IdGenerator } from "../shared/ids.ts";
import type { AgentSessionTurn } from "../shared/session-model.ts";
import {
  storedSessionSnapshotCondition,
  updateStoredSessions,
  type StoredSessionSnapshot,
} from "./session-store-persistence.ts";

function activeTurnCondition(sessionId: string) {
  return and(
    eq(agentSessionTurns.sessionId, sessionId),
    eq(agentSessionTurns.isDeleted, false),
  );
}

export function activeSessionTurnId(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): string | null {
  const condition = and(
    activeTurnCondition(sessionId),
    isNull(agentSessionTurns.endedAt),
  );
  return (
    database
      .select({ turn: agentSessionTurns.id })
      .from(agentSessionTurns)
      .where(condition)
      .get()?.turn ?? null
  );
}

interface SessionTurnInsertOptions {
  readonly database: Pick<AppDatabase, "insert">;
  readonly executionGeneration: number;
  readonly generateId: IdGenerator;
  readonly id?: string;
  readonly now: number;
  readonly segment: number;
  readonly sessionId: string;
  readonly startedAt?: number;
  readonly userId: string;
}

export function insertSessionTurn(options: SessionTurnInsertOptions): string {
  const id = options.id ?? options.generateId(options.now);
  options.database
    .insert(agentSessionTurns)
    .values({
      ...createdAuditFields(options.userId, options.now),
      executionGeneration: options.executionGeneration,
      id,
      segment: options.segment,
      sessionId: options.sessionId,
      startedAt: new Date(
        Math.min(options.startedAt ?? options.now, options.now),
      ),
      userId: options.userId,
    })
    .run();
  return id;
}

function endSessionTurn(
  database: Pick<AppDatabase, "update">,
  condition: SQL | undefined,
  now: number,
): void {
  database
    .update(agentSessionTurns)
    .set({
      endedAt: new Date(now),
      ...updatedAuditFields(SYSTEM_ID, now),
    })
    .where(and(condition, isNull(agentSessionTurns.endedAt)))
    .run();
}

function currentTurnCondition(
  sessionId: string,
  generation: number,
  segment?: number,
) {
  return and(
    activeTurnCondition(sessionId),
    eq(agentSessionTurns.executionGeneration, generation),
    segment === undefined ? undefined : eq(agentSessionTurns.segment, segment),
    isNull(agentSessionTurns.endedAt),
  );
}

export function endGenerationSessionTurn(
  database: Pick<AppDatabase, "select" | "update">,
  sessionId: string,
  generation: number,
  now: number,
): void {
  const activeTurn = database
    .select({
      id: agentSessionTurns.id,
      segment: agentSessionTurns.segment,
      startedAt: agentSessionTurns.startedAt,
    })
    .from(agentSessionTurns)
    .where(currentTurnCondition(sessionId, generation))
    .get();
  if (activeTurn === undefined) {
    return;
  }
  const activeTurnMessages = and(
    eq(agentMessages.turnId, activeTurn.id),
    eq(agentMessages.isDeleted, false),
    eq(agentMessages.sessionId, sessionId),
  );
  const boundaryMessageId =
    database
      .select({ boundary: agentMessages.id })
      .from(agentMessages)
      .where(activeTurnMessages)
      .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id))
      .get()?.boundary ?? null;
  const condition = and(
    currentTurnCondition(sessionId, generation, activeTurn.segment),
    eq(agentSessionTurns.id, activeTurn.id),
  );
  const turnUpdate = database
    .update(agentSessionTurns)
    .set({ boundaryMessageId });
  turnUpdate.where(condition).run();
  endSessionTurn(
    database,
    condition,
    Math.max(now, activeTurn.startedAt.getTime()),
  );
}

export interface SessionGenerationSettlement {
  readonly condition: SQL | undefined;
  readonly database: Pick<AppDatabase, "select" | "update">;
  readonly generation: number;
  readonly now: number;
  readonly sessionId: string;
  readonly values: Parameters<typeof updateStoredSessions>[2];
}

export function updateSessionAndEndGenerationTurn(
  options: SessionGenerationSettlement,
): boolean {
  if (
    !updateStoredSessions(options.database, options.condition, options.values)
  ) {
    return false;
  }
  endGenerationSessionTurn(
    options.database,
    options.sessionId,
    options.generation,
    options.now,
  );
  return true;
}

export function updateStoredSnapshotAndEndGenerationTurn(
  ...[database, session, now, values]: readonly [
    database: Pick<AppDatabase, "select" | "update">,
    session: StoredSessionSnapshot,
    now: number,
    values: Parameters<typeof updateStoredSessions>[2],
  ]
): boolean {
  return updateSessionAndEndGenerationTurn({
    condition: storedSessionSnapshotCondition(session),
    database,
    generation: session.executionGeneration,
    now,
    sessionId: session.id,
    values,
  });
}

type SessionTurnRotationOptions = Omit<SessionTurnInsertOptions, "database"> & {
  readonly database: Pick<AppDatabase, "insert" | "select" | "update">;
  readonly previousExecutionGeneration: number;
};

export function rotateSessionTurn(options: SessionTurnRotationOptions): string {
  const startedAt = Math.min(options.startedAt ?? options.now, options.now);
  endGenerationSessionTurn(
    options.database,
    options.sessionId,
    options.previousExecutionGeneration,
    startedAt,
  );
  return insertSessionTurn({ ...options, startedAt });
}

export function readSessionTurns(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): readonly AgentSessionTurn[] {
  return database
    .select({
      boundaryMessageId: agentSessionTurns.boundaryMessageId,
      endedAt: agentSessionTurns.endedAt,
      executionGeneration: agentSessionTurns.executionGeneration,
      id: agentSessionTurns.id,
      startedAt: agentSessionTurns.startedAt,
    })
    .from(agentSessionTurns)
    .where(
      and(
        activeTurnCondition(sessionId),
        eq(
          agentSessionTurns.segment,
          database
            .select({ segment: agentSessions.currentSegment })
            .from(agentSessions)
            .where(eq(agentSessions.id, sessionId)),
        ),
      ),
    )
    .orderBy(agentSessionTurns.startedAt, agentSessionTurns.id)
    .all()
    .map((turn) => ({
      ...turn,
      endedAt: turn.endedAt?.getTime() ?? null,
      startedAt: turn.startedAt.getTime(),
    }));
}
