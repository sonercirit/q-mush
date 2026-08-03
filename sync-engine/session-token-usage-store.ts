import { and, eq, sql } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages } from "../shared/database/schema.ts";
import type { AgentTokenUsageSummary } from "../shared/session-token-usage.ts";

const reportedUsage = and(
  sql`${agentMessages.inputTokens} IS NOT NULL`,
  sql`${agentMessages.outputTokens} IS NOT NULL`,
  sql`${agentMessages.cachedInputTokens} IS NOT NULL`,
  sql`${agentMessages.cacheWriteInputTokens} IS NOT NULL`,
);

function usageSummary(
  database: Pick<AppDatabase, "select">,
  condition: ReturnType<typeof and>,
): AgentTokenUsageSummary {
  const usage = database
    .select({
      cacheWriteInputTokens: sql<number>`coalesce(sum(CASE WHEN ${reportedUsage} THEN ${agentMessages.cacheWriteInputTokens} ELSE 0 END), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(CASE WHEN ${reportedUsage} THEN ${agentMessages.cachedInputTokens} ELSE 0 END), 0)`,
      inputTokens: sql<number>`coalesce(sum(CASE WHEN ${reportedUsage} THEN ${agentMessages.inputTokens} ELSE 0 END), 0)`,
      outputTokens: sql<number>`coalesce(sum(CASE WHEN ${reportedUsage} THEN ${agentMessages.outputTokens} ELSE 0 END), 0)`,
      reportedStepCount: sql<number>`coalesce(sum(CASE WHEN ${reportedUsage} THEN 1 ELSE 0 END), 0)`,
      stepCount: sql<number>`count(*)`,
    })
    .from(agentMessages)
    .where(and(condition, eq(agentMessages.role, "assistant")))
    .get();
  return {
    cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? 0,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reportedStepCount: usage?.reportedStepCount ?? 0,
    stepCount: usage?.stepCount ?? 0,
  };
}

export function storedSessionTokenUsage(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
): AgentTokenUsageSummary {
  return usageSummary(database, eq(agentMessages.sessionId, sessionId));
}

export function storedSegmentTokenUsage(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  segment: number,
): AgentTokenUsageSummary {
  return usageSummary(
    database,
    and(
      eq(agentMessages.sessionId, sessionId),
      eq(agentMessages.segment, segment),
    ),
  );
}
