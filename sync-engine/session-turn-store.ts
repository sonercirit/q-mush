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
      startedAt: new Date(options.now),
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
    .select({ id: agentSessionTurns.id, segment: agentSessionTurns.segment })
    .from(agentSessionTurns)
    .where(currentTurnCondition(sessionId, generation))
    .get();
  if (activeTurn === undefined) {
    return;
  }
  const messageSession = eq(agentMessages.sessionId, sessionId);
  const activeMessage = eq(agentMessages.isDeleted, false);
  const messages = database.select({ id: agentMessages.id });
  const orderedMessages = messages
    .from(agentMessages)
    .where(and(messageSession, activeMessage))
    .orderBy(desc(agentMessages.createdAt), desc(agentMessages.id));
  const boundaryMessageId = orderedMessages.get()?.id ?? null;
  const condition = and(
    currentTurnCondition(sessionId, generation, activeTurn.segment),
    eq(agentSessionTurns.id, activeTurn.id),
  );
  const turnUpdate = database
    .update(agentSessionTurns)
    .set({ boundaryMessageId });
  turnUpdate.where(condition).run();
  endSessionTurn(database, condition, now);
}

type SessionTurnRotationOptions = Omit<SessionTurnInsertOptions, "database"> & {
  readonly database: Pick<AppDatabase, "insert" | "select" | "update">;
  readonly previousExecutionGeneration: number;
};

export function rotateSessionTurn(options: SessionTurnRotationOptions): string {
  endGenerationSessionTurn(
    options.database,
    options.sessionId,
    options.previousExecutionGeneration,
    options.now,
  );
  return insertSessionTurn(options);
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
