import type { AgentModelTurn } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";

export type CompactionUsage = AgentSessionUsageUpdate & {
  readonly contextTokens: null;
};

type CostEstimate = Pick<AgentModelTurn, "costUsd" | "tokenUsage">;
type EstimateCost = (estimate: CostEstimate) => number | null;

function usageCost(
  turn: CostEstimate,
  estimateCost: EstimateCost,
): Pick<AgentSessionUsageUpdate, "costBasis" | "costUsd"> {
  const costUsd = turn.costUsd ?? estimateCost(turn);
  return {
    costBasis:
      costUsd === null
        ? null
        : turn.costUsd === null
          ? "estimated"
          : "reported",
    costUsd,
  };
}

export function agentTurnUsage(
  turn: CostEstimate & Pick<AgentModelTurn, "contextTokens">,
  estimateCost: EstimateCost,
): AgentSessionUsageUpdate | undefined {
  const cost = usageCost(turn, estimateCost);
  return turn.contextTokens === null && cost.costUsd === null
    ? undefined
    : { contextTokens: turn.contextTokens, ...cost };
}

export function compactionUsage(
  turn: CostEstimate,
  estimateCost: EstimateCost,
): CompactionUsage {
  return { contextTokens: null, ...usageCost(turn, estimateCost) };
}
