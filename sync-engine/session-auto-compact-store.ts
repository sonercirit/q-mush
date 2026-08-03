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

export function setStoredSessionAutoCompact(
  context: SessionSettingContext,
  ...[userId, sessionId, autoCompact, now, workspaceId]: readonly [
    string,
    string,
    boolean,
    number,
    string?,
  ]
): AgentSessionDetail | undefined {
  const updated = updateStoredSessions(
    context.database,
    activeSessionCondition(userSessionFilter(userId, sessionId, workspaceId)),
    { autoCompact, ...updatedAuditFields(userId, now) },
  );
  return updated ? context.read(userId, sessionId, workspaceId) : undefined;
}
