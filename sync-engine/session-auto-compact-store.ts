import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { userSessionFilter } from "./session-filter.ts";
import type { SessionSettingsReader } from "./session-settings-types.ts";
import {
  activeSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";

export interface SessionSettingContext {
  readonly database: AppDatabase;
  readonly read: SessionSettingsReader;
}

export type SessionCompactionFlagParameters = readonly [
  userId: string,
  sessionId: string,
  enabled: boolean,
  now: number,
  workspaceId?: string,
];

export function setStoredSessionCompactionFlag(
  context: SessionSettingContext,
  flag: "autoCompact" | "idleCompact",
  ...[
    userId,
    sessionId,
    enabled,
    now,
    workspaceId,
  ]: SessionCompactionFlagParameters
): AgentSessionDetail | undefined {
  const updated = updateStoredSessions(
    context.database,
    activeSessionCondition(userSessionFilter(userId, sessionId, workspaceId)),
    { [flag]: enabled, ...updatedAuditFields(userId, now) },
  );
  return updated ? context.read(userId, sessionId, workspaceId) : undefined;
}
