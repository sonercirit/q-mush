import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessionTurns } from "../shared/database/schema.ts";
import type {
  AgentSessionMessage,
  AgentSessionTurn,
} from "../shared/session-model.ts";
import { STORED_SESSION_MESSAGE_SELECTION } from "./session-message-selection.ts";
import { summarizeStoredMessage } from "./session-store-read.ts";
import {
  STORED_SESSION_TURN_SELECTION,
  summarizeStoredTurn,
} from "./session-turn-read.ts";

function generationTurnCondition(sessionId: string, generation: number) {
  return and(
    eq(agentSessionTurns.sessionId, sessionId),
    eq(agentSessionTurns.executionGeneration, generation),
    eq(agentSessionTurns.isDeleted, false),
  );
}

/**
 * Reads one execution generation independently of the current cache segment.
 * Administrative cache resets and compaction may move or soft-delete the
 * transcript before a terminal callback is claimed.
 */
export function readStoredSessionGenerationTranscript(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  generation: number,
): {
  readonly messages: readonly AgentSessionMessage[];
  readonly turns: readonly AgentSessionTurn[];
} {
  const storedTurns = database
    .select(STORED_SESSION_TURN_SELECTION)
    .from(agentSessionTurns)
    .where(generationTurnCondition(sessionId, generation))
    .orderBy(agentSessionTurns.startedAt, agentSessionTurns.id)
    .all();
  const turns = storedTurns.map(summarizeStoredTurn);
  const storedMessages =
    turns.length === 0
      ? []
      : database
          .select(STORED_SESSION_MESSAGE_SELECTION)
          .from(agentMessages)
          .innerJoin(
            agentSessionTurns,
            eq(agentMessages.turnId, agentSessionTurns.id),
          )
          .where(
            and(
              eq(agentMessages.sessionId, sessionId),
              generationTurnCondition(sessionId, generation),
            ),
          )
          .orderBy(desc(agentMessages.id), desc(agentMessages.createdAt))
          .limit(3)
          .all()
          .reverse();
  const messages = storedMessages.map(summarizeStoredMessage);
  return { messages, turns };
}
