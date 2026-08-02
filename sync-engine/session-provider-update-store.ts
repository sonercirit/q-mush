import { sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import { activeSessionDuration } from "../shared/session-timing.ts";
import { workspaceSessionCondition } from "./session-store-persistence.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import { updateSessionAndEndGenerationTurn } from "./session-turn-store.ts";
export type SessionProviderUpdateStoreResult = Readonly<{
  detail?: AgentSessionDetail;
  status: "conflict" | "not_found" | "unchanged" | "updated";
}>;

type ReadProviderUpdateSession = (
  identity: readonly [userId: string, sessionId: string, workspaceId: string],
) => AgentSessionDetail | undefined;

export function updateStoredSessionProvider(
  database: AppDatabase,
  read: ReadProviderUpdateSession,
  input: SessionProviderUpdateInput & {
    readonly maxContextTokens: number | null;
    readonly now: number;
    readonly providerPricing: ProviderModelPricing | null;
    readonly userId: string;
  },
): SessionProviderUpdateStoreResult {
  const identity = [input.userId, input.sessionId, input.workspaceId] as const;
  const existing = read(identity);
  if (existing === undefined) return { status: "not_found" };
  if (sessionProviderSelectionMatches(existing, input)) {
    return { detail: existing, status: "unchanged" };
  }
  if (existing.generation !== input.expectedGeneration) {
    return { status: "conflict" };
  }

  const active = ["queued", "running", "paused"].includes(existing.status);
  const values = {
    currentContextTokens: 0,
    currentSegment: sql<number>`${agentSessions.currentSegment} + 1`,
    executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
    maxContextTokens: input.maxContextTokens,
    model: input.model,
    interruptedHandoff: null,
    provider: input.provider,
    providerCredentialId: input.credentialId,
    openRouterProviderTag: input.openRouterProviderTag,
    providerPricing: serializeProviderPricing(input.providerPricing),
    restartHandoff: null,
    ...updatedAuditFields(input.userId, input.now),
  };
  const timing = active
    ? {
        status: "idle" as const,
        activeDurationMs: activeSessionDuration(existing, input.now),
        activeStartedAt: null,
      }
    : {};
  const condition = workspaceSessionCondition(input, input.expectedGeneration);
  const generation = input.expectedGeneration;
  const changed = database.transaction((transaction) =>
    updateSessionAndEndGenerationTurn({
      condition,
      database: transaction,
      generation,
      now: input.now,
      sessionId: input.sessionId,
      values: { ...values, ...timing },
    }),
  );
  if (!changed) return { status: "conflict" };

  const detail = read(identity);
  if (detail === undefined) {
    throw new Error("Provider update committed but the session disappeared");
  }
  return { detail, status: "updated" };
}
