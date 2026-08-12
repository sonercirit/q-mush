import {
  readAgentSessionToolNames,
  type AgentSessionToolName,
} from "../shared/agent-tools.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { effectiveContextTokenLimit } from "../shared/session-context-limit.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { parseRestartHandoff } from "./session-restart-store.ts";
import {
  storedSessionCondition,
  type SessionFilter,
} from "./session-store-persistence.ts";
import { parseProviderPricing } from "./session-store-read.ts";

export function selectStoredSessions(
  database: Pick<AppDatabase, "select">,
  filter: SessionFilter,
) {
  return database
    .select(storedSessionSelection())
    .from(agentSessions)
    .where(storedSessionCondition(filter));
}

function storedSessionSelection() {
  return {
    activeDurationMs: agentSessions.activeDurationMs,
    activeStartedAt: agentSessions.activeStartedAt,
    agentFilePath: agentSessions.agentFilePath,
    autoCompact: agentSessions.autoCompact,
    costBasis: agentSessions.costBasis,
    costUsd: agentSessions.costUsd,
    createdAt: agentSessions.createdAt,
    credentialId: agentSessions.providerCredentialId,
    currentContextTokens: agentSessions.currentContextTokens,
    currentSegment: agentSessions.currentSegment,
    executionEnvironment: agentSessions.executionEnvironment,
    executionGeneration: agentSessions.executionGeneration,
    id: agentSessions.id,
    idleCompact: agentSessions.idleCompact,
    maxContextTokens: agentSessions.maxContextTokens,
    userContextTokenCap: agentSessions.userContextTokenCap,
    model: agentSessions.model,
    openRouterProviderTag: agentSessions.openRouterProviderTag,
    parentExecutionGeneration: agentSessions.parentExecutionGeneration,
    parentSessionId: agentSessions.parentSessionId,
    provider: agentSessions.provider,
    providerPricing: agentSessions.providerPricing,
    reasoningEffort: agentSessions.reasoningEffort,
    restartHandoff: agentSessions.restartHandoff,
    runnerId: agentSessions.runnerId,
    runnerRequired: agentSessions.runnerRequired,
    status: agentSessions.status,
    title: agentSessions.title,
    tools: agentSessions.tools,
    updatedAt: agentSessions.updatedAt,
    workingDirectory: agentSessions.workingDirectory,
    workspaceId: agentSessions.workspaceId,
  };
}

type StoredSessionSummary = Pick<
  typeof agentSessions.$inferSelect,
  | "activeDurationMs"
  | "activeStartedAt"
  | "agentFilePath"
  | "autoCompact"
  | "costBasis"
  | "costUsd"
  | "createdAt"
  | "currentContextTokens"
  | "currentSegment"
  | "executionEnvironment"
  | "executionGeneration"
  | "id"
  | "idleCompact"
  | "maxContextTokens"
  | "userContextTokenCap"
  | "model"
  | "openRouterProviderTag"
  | "parentExecutionGeneration"
  | "parentSessionId"
  | "provider"
  | "providerPricing"
  | "reasoningEffort"
  | "restartHandoff"
  | "runnerId"
  | "runnerRequired"
  | "status"
  | "title"
  | "tools"
  | "updatedAt"
  | "workingDirectory"
  | "workspaceId"
> & { readonly credentialId: string };

function parseStoredTools(value: string): readonly AgentSessionToolName[] {
  try {
    const tools = readAgentSessionToolNames(JSON.parse(value));
    if (tools !== undefined) {
      return tools;
    }
  } catch {
    // The common error below identifies corrupt local data.
  }
  throw new Error("Stored agent session tools are invalid");
}

export function summarizeStoredSession(
  stored: StoredSessionSummary,
): AgentSessionSummary {
  const {
    currentSegment,
    executionGeneration: generation,
    maxContextTokens,
    userContextTokenCap,
    ...summary
  } = stored;
  return {
    ...summary,
    generation,
    maxContextTokens: effectiveContextTokenLimit(
      maxContextTokens,
      userContextTokenCap,
    ),
    userContextTokenCap,
    hasOlderSegments: currentSegment > 0,
    activeStartedAt: stored.activeStartedAt?.getTime() ?? null,
    createdAt: stored.createdAt.getTime(),
    providerPricing: parseProviderPricing(stored.providerPricing),
    pendingQuestions: null,
    restartHandoff: parseRestartHandoff(stored.restartHandoff),
    tools: parseStoredTools(stored.tools),
    updatedAt: stored.updatedAt.getTime(),
  };
}
