import { sql } from "drizzle-orm";
import { updatedAuditFields } from "../shared/audit.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { contextTokenCapValidationError } from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  sessionProviderSelectionMatches,
  type SessionProviderUpdateInput,
} from "../shared/session-provider-update.ts";
import { advanceStoredSessionGeneration } from "./session-generation-advance.ts";
import type { SessionRequestModelMetadata } from "./session-provider-selection.ts";
import {
  sessionTimingUpdate,
  workspaceSessionCondition,
} from "./session-store-persistence.ts";
import { serializeProviderPricing } from "./session-store-read.ts";
import {
  emitReportedParent,
  readUpdatedSessionDetail,
  type SessionStoreWriteResources,
} from "./session-store-resources.ts";
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

export function updateStoredSessionProvider(
  resources: SessionStoreWriteResources,
  input: SessionProviderUpdateInput &
    SessionRequestModelMetadata & {
      readonly now: number;
      readonly userId: string;
    },
): SessionProviderUpdateStoreResult {
  const existing = resources.read(
    input.userId,
    input.sessionId,
    input.workspaceId,
  );
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
    maxContextTokens: input.maxContextTokens,
    maxOutputTokens: input.maxOutputTokens,
    adaptiveThinking: input.adaptiveThinking,
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
  const condition = workspaceSessionCondition(
    { ...input },
    input.expectedGeneration,
  );
  const changed = resources.database.transaction((transaction) =>
    advanceStoredSessionGeneration({
      condition,
      database: transaction,
      generateId: resources.generateId,
      mode: "administrative",
      now: input.now,
      sessionId: input.sessionId,
      values: { ...values, ...timing },
    }),
  );
  if (changed === undefined) return { status: "conflict" };
  emitReportedParent(resources, input.userId, changed.reportedParent);

  const detail = readUpdatedSessionDetail(
    resources,
    input.userId,
    input.sessionId,
    input.workspaceId,
    "Provider update committed but the session disappeared",
  );
  return { detail, status: "updated" };
}
