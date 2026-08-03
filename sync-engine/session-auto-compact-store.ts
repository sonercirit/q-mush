import { updatedAuditFields } from "../shared/audit.ts";
import type { AppDatabase } from "../shared/database.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { userSessionFilter } from "./session-filter.ts";
import {
  activeSessionCondition,
  updateStoredSessions,
} from "./session-store-persistence.ts";

export function setStoredSessionAutoCompact(
  database: AppDatabase,
  read: (
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ) => AgentSessionDetail | undefined,
  userId: string,
  sessionId: string,
  autoCompact: boolean,
  now: number,
  workspaceId?: string,
): AgentSessionDetail | undefined {
  const updated = updateStoredSessions(
    database,
    activeSessionCondition(userSessionFilter(userId, sessionId, workspaceId)),
    { autoCompact, ...updatedAuditFields(userId, now) },
  );
  return updated ? read(userId, sessionId, workspaceId) : undefined;
}
