import { and, eq } from "drizzle-orm";
import { agentSessions } from "../shared/database/schema.ts";
import type { AgentSessionStatus } from "../shared/session-model.ts";

export interface SessionFilter {
  readonly id?: string;
  readonly status?: AgentSessionStatus;
  readonly userId?: string;
  readonly workspaceId?: string;
}

export function activeSessionCondition(filter: SessionFilter) {
  return and(
    eq(agentSessions.isDeleted, false),
    filter.id === undefined ? undefined : eq(agentSessions.id, filter.id),
    filter.status === undefined
      ? undefined
      : eq(agentSessions.status, filter.status),
    filter.userId === undefined
      ? undefined
      : eq(agentSessions.userId, filter.userId),
    filter.workspaceId === undefined
      ? undefined
      : eq(agentSessions.workspaceId, filter.workspaceId),
  );
}
