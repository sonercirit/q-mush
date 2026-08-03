import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import { agentSessions } from "../shared/database/schema.ts";
import { contextTokenCapValidationError } from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { userSessionFilter } from "./session-filter.ts";
import {
  activeSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";

export function updateStoredSessionContextTokenCap(options: {
  readonly database: AppDatabase;
  readonly now: number;
  readonly read: () => AgentSessionDetail | undefined;
  readonly sessionId: string;
  readonly userContextTokenCap: number | null;
  readonly userId: string;
  readonly workspaceId?: string;
}): AgentSessionDetail | undefined {
  const existing = options.read();
  if (existing === undefined) return undefined;
  const condition = activeSessionCondition(
    userSessionFilter(options.userId, options.sessionId, options.workspaceId),
  );
  const modelLimit = options.database
    .select({ limit: agentSessions.maxContextTokens })
    .from(agentSessions)
    .where(condition)
    .get()?.limit;
  if (modelLimit === undefined) return undefined;
  const error = contextTokenCapValidationError(
    options.userContextTokenCap,
    modelLimit,
  );
  if (error !== undefined) throw new Error(error);
  if (existing.userContextTokenCap === options.userContextTokenCap) {
    return existing;
  }
  const updated = updateStoredSessions(options.database, condition, {
    userContextTokenCap: options.userContextTokenCap,
    ...updatedAuditFields(options.userId, options.now),
  });
  return updated ? options.read() : undefined;
}
