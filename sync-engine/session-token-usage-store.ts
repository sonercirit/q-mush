import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages } from "../shared/database/schema.ts";
import {
  summarizeTokenUsage,
  type AgentTokenUsageSummary,
} from "../shared/session-token-usage.ts";

function usageSummary(options: {
  readonly condition: ReturnType<typeof and>;
  readonly database: Pick<AppDatabase, "select">;
}): AgentTokenUsageSummary {
  return summarizeTokenUsage(
    options.database
      .select({
        tokenUsage: {
          cacheWriteInputTokens: agentMessages.cacheWriteInputTokens,
          cachedInputTokens: agentMessages.cachedInputTokens,
          inputTokens: agentMessages.inputTokens,
          outputTokens: agentMessages.outputTokens,
        },
      })
      .from(agentMessages)
      .where(and(options.condition, eq(agentMessages.role, "assistant")))
      .all()
      .map(({ tokenUsage }) => ({
        tokenUsage: Object.values(tokenUsage).every((value) => value !== null)
          ? {
              cacheWriteInputTokens: tokenUsage.cacheWriteInputTokens ?? 0,
              cachedInputTokens: tokenUsage.cachedInputTokens ?? 0,
              inputTokens: tokenUsage.inputTokens ?? 0,
              outputTokens: tokenUsage.outputTokens ?? 0,
            }
          : null,
      })),
  );
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
