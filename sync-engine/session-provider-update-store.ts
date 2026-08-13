import { sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import type { ProviderModelPricing } from "../shared/provider-model-pricing.ts";
import { contextTokenCapValidationError } from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import {
  sessionTimingUpdate,
  workspaceSessionCondition,
} from "./session-store-persistence.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import { updateSessionAndEndGenerationTurn } from "./session-turn-store.ts";
export type SessionProviderUpdateStoreResult = Readonly<{
  detail?: AgentSessionDetail;
  error?: string;
  status:
    | "conflict"
    | "invalid_context_token_cap"
    | "not_found"
    | "unchanged"
    | "updated";
}>;

type ReadProviderUpdateSession = (
  identity: readonly [userId: string, sessionId: string, workspaceId: string],
) => AgentSessionDetail | undefined;

export function updateStoredSessionProvider(
  database: AppDatabase,
  read: ReadProviderUpdateSession,
  input: SessionProviderUpdateInput & {
    readonly maxContextTokens: number | null;
    readonly maxOutputTokens: number | null;
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
  const capError = contextTokenCapValidationError(
    existing.userContextTokenCap,
    input.maxContextTokens,
  );
  if (capError !== undefined) {
    const cap = existing.userContextTokenCap;
    const limit = input.maxContextTokens;
    const error =
      cap !== null && limit !== null && cap > limit
        ? `The current context token cap of ${cap.toLocaleString("en-US")} tokens exceeds the new model limit of ${limit.toLocaleString("en-US")} tokens. Lower or clear the cap before changing models.`
        : `${capError} Lower or clear the cap before changing models.`;
    return { error, status: "invalid_context_token_cap" };
  }

  const active = ["queued", "running", "paused"].includes(existing.status);
  const values = {
    currentContextTokens: 0,
    currentSegment: sql<number>`${agentSessions.currentSegment} + 1`,
    executionGeneration: sql`${agentSessions.executionGeneration} + 1`,
    maxContextTokens: input.maxContextTokens,
    maxOutputTokens: input.maxOutputTokens,
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
    ? { status: "idle" as const, ...sessionTimingUpdate(existing, input.now) }
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
