import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { SessionHistoryPage } from "../shared/session-history.ts";
import type { SessionStore } from "./session-store-interface.ts";

export interface SessionHistoryAuthority {
  readonly cursor: string | null;
  readonly sessionId: string;
  readonly workspaceId?: string;
}

/** Revalidates both owner and selected-workspace authority for browser history. */
export function readAuthorizedSessionHistory(
  store: SessionStore,
  user: AuthenticatedUser,
  authority: SessionHistoryAuthority,
): SessionHistoryPage | undefined {
  if (
    authority.workspaceId !== undefined &&
    store.get(user.id, authority.sessionId, authority.workspaceId) === undefined
  ) {
    return undefined;
  }
  return store.history(user.id, authority.sessionId, authority.cursor);
}
