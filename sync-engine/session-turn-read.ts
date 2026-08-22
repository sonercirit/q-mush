import { agentSessionTurns } from "../shared/database/schema.ts";
import type { AgentSessionTurn } from "../shared/session-model.ts";
import { readToolSettings } from "../shared/tool-limits.ts";

export const STORED_SESSION_TURN_SELECTION = {
  boundaryMessageId: agentSessionTurns.boundaryMessageId,
  endedAt: agentSessionTurns.endedAt,
  executionGeneration: agentSessionTurns.executionGeneration,
  id: agentSessionTurns.id,
  startedAt: agentSessionTurns.startedAt,
  executionLimitMinutes: agentSessionTurns.toolExecutionLimitMinutes,
  outputLimitCharacters: agentSessionTurns.toolOutputLimitCharacters,
};

export function summarizeStoredTurn(turn: {
  readonly boundaryMessageId: string | null;
  readonly endedAt: Date | null;
  readonly executionGeneration: number;
  readonly id: string;
  readonly startedAt: Date;
  readonly executionLimitMinutes: number;
  readonly outputLimitCharacters: number;
}): AgentSessionTurn {
  const { executionLimitMinutes, outputLimitCharacters, ...detail } = turn;
  const toolSettings = readToolSettings({
    executionLimitMinutes,
    outputLimitCharacters,
  });
  if (toolSettings === undefined)
    throw new Error("Invalid stored turn tool settings");
  return {
    ...detail,
    endedAt: turn.endedAt?.getTime() ?? null,
    startedAt: turn.startedAt.getTime(),
    toolSettings,
  };
}
