import type { AgentTokenUsage } from "./agent-loop.ts";

export interface AgentTokenUsageSummary extends AgentTokenUsage {
  // Input tokens of the latest reported step: everything before that step's
  // request was available for caching, so the cacheable total is the summed
  // input minus this value.
  readonly lastInputTokens: number;
  readonly reportedStepCount: number;
  readonly stepCount: number;
}

// Cache reuse is judged against what was available for caching — the prefix a
// previous request already established — not total input, which fresh tool
// output dilutes. Cross-session shared prefixes can read more than this
// session made available, so the rate clamps at 100%.
export function tokenCacheRate(
  cachedInputTokens: number,
  availableInputTokens: number,
): number | null {
  return availableInputTokens <= 0
    ? null
    : Math.min(1, cachedInputTokens / availableInputTokens);
}

export function summaryTokenCacheRate(
  summary: AgentTokenUsageSummary,
): number | null {
  return tokenCacheRate(
    summary.cachedInputTokens,
    summary.inputTokens - summary.lastInputTokens,
  );
}
