import type { AgentTokenUsage } from "./agent-loop.ts";

export interface AgentTokenUsageSummary extends AgentTokenUsage {
  readonly reportedStepCount: number;
  readonly stepCount: number;
}

export interface AgentTokenUsageStep {
  readonly tokenUsage?: AgentTokenUsage | null;
}

const EMPTY_AGENT_TOKEN_USAGE: AgentTokenUsage = {
  cacheWriteInputTokens: 0,
  cachedInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export function summarizeTokenUsage(
  steps: readonly AgentTokenUsageStep[],
): AgentTokenUsageSummary {
  const summary: {
    cacheWriteInputTokens: number;
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    reportedStepCount: number;
    stepCount: number;
  } = {
    ...EMPTY_AGENT_TOKEN_USAGE,
    reportedStepCount: 0,
    stepCount: steps.length,
  };
  for (const { tokenUsage } of steps) {
    if (tokenUsage === null || tokenUsage === undefined) continue;
    summary.cacheWriteInputTokens += tokenUsage.cacheWriteInputTokens;
    summary.cachedInputTokens += tokenUsage.cachedInputTokens;
    summary.inputTokens += tokenUsage.inputTokens;
    summary.outputTokens += tokenUsage.outputTokens;
    summary.reportedStepCount += 1;
  }
  return summary;
}

export function tokenCacheRate(
  usage: Pick<AgentTokenUsage, "cachedInputTokens" | "inputTokens">,
): number | null {
  return usage.inputTokens === 0
    ? null
    : usage.cachedInputTokens / usage.inputTokens;
}
