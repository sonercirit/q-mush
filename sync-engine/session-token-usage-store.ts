import { and, eq, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages } from "../shared/database/schema.ts";
import type { AgentTokenUsageSummary } from "../shared/session-token-usage.ts";

const completeUsage = sql`
  ${agentMessages.inputTokens} IS NOT NULL AND
  ${agentMessages.outputTokens} IS NOT NULL AND
  ${agentMessages.cachedInputTokens} IS NOT NULL AND
  ${agentMessages.cacheWriteInputTokens} IS NOT NULL
`;

function sumReported(column: AnySQLiteColumn): SQL<number> {
  return sql<number>`coalesce(sum(CASE WHEN ${completeUsage} THEN ${column} ELSE 0 END), 0)`;
}

function usageSummary(options: {
  readonly condition: ReturnType<typeof and>;
  readonly database: Pick<AppDatabase, "select">;
}): AgentTokenUsageSummary {
  const usage = options.database
    .select({
      cacheWriteInputTokens: sumReported(agentMessages.cacheWriteInputTokens),
      cachedInputTokens: sumReported(agentMessages.cachedInputTokens),
      inputTokens: sumReported(agentMessages.inputTokens),
      outputTokens: sumReported(agentMessages.outputTokens),
      reportedStepCount: sql<number>`coalesce(sum(CASE WHEN ${completeUsage} THEN 1 ELSE 0 END), 0)`,
      stepCount: sql<number>`count(*)`,
    })
    .from(agentMessages)
    .where(and(eq(agentMessages.role, "assistant"), options.condition))
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
  return usageSummary({
    condition: eq(agentMessages.sessionId, sessionId),
    database,
  });
}

export function storedSegmentTokenUsage(
  database: Pick<AppDatabase, "select">,
  sessionId: string,
  segment: number,
): AgentTokenUsageSummary {
  return usageSummary({
    condition: and(
      eq(agentMessages.segment, segment),
      eq(agentMessages.sessionId, sessionId),
    ),
    database,
  });
}
