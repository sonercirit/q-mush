import type { AgentModelStep } from "../shared/agent-loop.ts";
import type { AgentSessionUsageUpdate } from "../shared/session-model.ts";

export type CompactionUsage = AgentSessionUsageUpdate;

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

function withTokenUsage(
  step: Pick<AgentModelStep, "tokenUsage">,
): Pick<AgentSessionUsageUpdate, "tokenUsage"> {
  return step.tokenUsage === null ? {} : { tokenUsage: step.tokenUsage };
}

export function agentStepUsage(
  step: CostEstimate & Pick<AgentModelStep, "contextTokens">,
  estimateCost: EstimateCost,
): AgentSessionUsageUpdate | undefined {
  const cost = usageCost(step, estimateCost);
  return step.contextTokens === null &&
    cost.costUsd === null &&
    step.tokenUsage === null
    ? undefined
    : {
        contextTokens: step.contextTokens,
        ...cost,
        ...withTokenUsage(step),
      };
}

export function compactionUsage(
  step: CostEstimate & Pick<AgentModelStep, "contextTokens">,
  estimateCost: EstimateCost,
): CompactionUsage {
  return {
    contextTokens: step.contextTokens,
    ...usageCost(step, estimateCost),
    ...withTokenUsage(step),
  };
}
