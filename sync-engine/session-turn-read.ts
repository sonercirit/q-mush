import { agentSessionTurns } from "../shared/database/schema.ts";
import type { AgentSessionTurn } from "../shared/session-model.ts";

export const STORED_SESSION_TURN_SELECTION = {
  boundaryMessageId: agentSessionTurns.boundaryMessageId,
  endedAt: agentSessionTurns.endedAt,
  executionGeneration: agentSessionTurns.executionGeneration,
  id: agentSessionTurns.id,
  startedAt: agentSessionTurns.startedAt,
};

export function summarizeStoredTurn(turn: {
  readonly boundaryMessageId: string | null;
  readonly endedAt: Date | null;
  readonly executionGeneration: number;
  readonly id: string;
  readonly startedAt: Date;
}): AgentSessionTurn {
  return {
    ...turn,
    endedAt: turn.endedAt?.getTime() ?? null,
    startedAt: turn.startedAt.getTime(),
  };
}
