import type { SessionFilter } from "./session-store-persistence.ts";

export function userSessionFilter(
  userId: string,
  sessionId: string | undefined,
  workspaceId?: string,
): SessionFilter {
  return {
    ...(sessionId === undefined ? {} : { id: sessionId }),
    userId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}
