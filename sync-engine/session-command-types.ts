import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export type AuthenticatedSessionAction = (
  user: AuthenticatedUser,
  sessionId: string,
  workspaceId: string,
) => Promise<AgentSessionDetail>;

export type SessionDetailLookup = (
  userId: string,
  sessionId: string,
  workspaceId?: string,
) => AgentSessionDetail | undefined;

export interface SessionDetailReader {
  readonly detailForUser: SessionDetailLookup;
}
