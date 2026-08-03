import type { AgentTokenUsage } from "./agent-loop.ts";

export interface AgentTokenUsageSummary extends AgentTokenUsage {
  readonly reportedStepCount: number;
  readonly stepCount: number;
}

export function tokenCacheRate(
  usage: Pick<AgentTokenUsage, "cachedInputTokens" | "inputTokens">,
): number | null {
  return usage.inputTokens === 0
    ? null
    : usage.cachedInputTokens / usage.inputTokens;
}
