import type { AgentModelStep } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";

export type CompactionUsage = AgentSessionUsageUpdate & {
  readonly contextTokens: null;
};

type CostEstimate = Pick<AgentModelStep, "costUsd" | "tokenUsage">;
type EstimateCost = (estimate: CostEstimate) => number | null;

function usageCost(
  step: CostEstimate,
  estimateCost: EstimateCost,
): Pick<AgentSessionUsageUpdate, "costBasis" | "costUsd"> {
  const costUsd = step.costUsd ?? estimateCost(step);
  return {
    costBasis:
      costUsd === null
        ? null
        : step.costUsd === null
          ? "estimated"
          : "reported",
    costUsd,
  };
}

export function agentStepUsage(
  step: CostEstimate & Pick<AgentModelStep, "contextTokens">,
  estimateCost: EstimateCost,
): AgentSessionUsageUpdate | undefined {
  const cost = usageCost(step, estimateCost);
  return step.contextTokens === null && cost.costUsd === null
    ? undefined
    : { contextTokens: step.contextTokens, ...cost };
}

export function compactionUsage(
  step: CostEstimate,
  estimateCost: EstimateCost,
): CompactionUsage {
  return { contextTokens: null, ...usageCost(step, estimateCost) };
}
