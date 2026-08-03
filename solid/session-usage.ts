import {
  tokenCacheRate,
  type AgentTokenUsageSummary,
} from "../shared/session-token-usage.ts";
import { formatTokenCount } from "./session-context-client.tsx";

export function sessionUsageText(usage: AgentTokenUsageSummary): string {
  const cacheRate = tokenCacheRate(usage);
  const coverage =
    usage.reportedStepCount === usage.stepCount
      ? `${String(usage.stepCount)} steps`
      : `${String(usage.reportedStepCount)} of ${String(usage.stepCount)} steps`;
  return [
    ...(usage.reportedStepCount === 0
      ? ["Usage: Not reported"]
      : [
          `Input: ${formatTokenCount(usage.inputTokens)}`,
          `Output: ${formatTokenCount(usage.outputTokens)}`,
          `Cached: ${formatTokenCount(usage.cachedInputTokens)}`,
          `Cache write: ${formatTokenCount(usage.cacheWriteInputTokens)}`,
          ...(cacheRate === null
            ? []
            : [`Cache rate: ${String(Math.round(cacheRate * 100))}%`]),
        ]),
    coverage,
  ].join(" · ");
}
