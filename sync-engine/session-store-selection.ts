import { and, desc, eq, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";

export interface SessionFilter {
  readonly id?: string;
  readonly status?: AgentSessionStatus;
  readonly userId?: string;
}

export function activeSessionCondition(filter: SessionFilter): SQL | undefined {
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.status === undefined
      ? undefined
      : eq(agentSessions.status, filter.status),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
  );
}

export function runningCondition(
  sessionId: string,
  userId?: string,
): SQL | undefined {
  return activeSessionCondition({
    id: sessionId,
    status: "running",
    ...(userId === undefined ? {} : { userId }),
  });
}

export function selectSessions(database: AppDatabase, filter: SessionFilter) {
  return database
    .select({
      activeDurationMs: agentSessions.activeDurationMs,
      activeStartedAt: agentSessions.activeStartedAt,
      autoCompact: agentSessions.autoCompact,
      costBasis: agentSessions.costBasis,
      costUsd: agentSessions.costUsd,
      createdAt: agentSessions.createdAt,
      credentialId: agentSessions.providerCredentialId,
      currentContextTokens: agentSessions.currentContextTokens,
      id: agentSessions.id,
      maxContextTokens: agentSessions.maxContextTokens,
      model: agentSessions.model,
      provider: agentSessions.provider,
      providerPricing: agentSessions.providerPricing,
      reasoningEffort: agentSessions.reasoningEffort,
      runnerId: agentSessions.runnerId,
      status: agentSessions.status,
      title: agentSessions.title,
      tools: agentSessions.tools,
      updatedAt: agentSessions.updatedAt,
      workingDirectory: agentSessions.workingDirectory,
    })
    .from(agentSessions)
    .where(activeSessionCondition(filter));
}

export function orderedSessions(database: AppDatabase, userId: string) {
  return selectSessions(database, { userId }).orderBy(
    desc(agentSessions.updatedAt),
    desc(agentSessions.id),
  );
}
