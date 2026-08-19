import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages, agentSessionTurns } from "../shared/database/schema.ts";
import type {
  AgentSessionMessage,
  AgentSessionTurn,
} from "../shared/session-model.ts";
import { STORED_SESSION_MESSAGE_SELECTION } from "./session-message-selection.ts";
import { summarizeStoredMessage } from "./session-store-read.ts";

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
  const turns = database
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
        eq(agentSessionTurns.sessionId, sessionId),
        eq(agentSessionTurns.executionGeneration, generation),
        eq(agentSessionTurns.isDeleted, false),
      ),
    )
    .orderBy(agentSessionTurns.startedAt, agentSessionTurns.id)
    .all()
    .map((turn) => ({
      ...turn,
      endedAt: turn.endedAt?.getTime() ?? null,
      startedAt: turn.startedAt.getTime(),
    }));
  const messages =
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
              eq(agentSessionTurns.sessionId, sessionId),
              eq(agentSessionTurns.executionGeneration, generation),
              eq(agentSessionTurns.isDeleted, false),
            ),
          )
          .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
          .all()
          .map(summarizeStoredMessage);
  return { messages, turns };
}
