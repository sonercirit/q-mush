import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import type { GoogleAuth } from "./auth.ts";
import { createApiError } from "./http.ts";
import { updateSessionCompactionMode } from "./session-compaction-actions.ts";
import type { SessionStore } from "./session-store.ts";
import {
  requestSessionWorkspaceId,
  type SessionWorkspaceReader,
} from "./session-workspace.ts";

export function updateStoredSessionCompactionMode(
  dependencies: {
    readonly auth: GoogleAuth;
    readonly notify: (userId: string, sessionId: string) => void;
    readonly now: () => number;
    readonly store: SessionStore;
    readonly workspaces: SessionWorkspaceReader;
  },
  request: Request,
  sessionId: string,
  user: AuthenticatedUser,
): Promise<Response> {
  const workspaceId = requestSessionWorkspaceId(
    request,
    user.id,
    dependencies.workspaces,
  );
  if (workspaceId === undefined) {
    return Promise.resolve(createApiError("workspace_unavailable", 409));
  }
  return updateSessionCompactionMode(
    {
      auth: dependencies.auth,
      now: dependencies.now,
      onChanged: (detail: AgentSessionDetail, changedUserId: string) => {
        dependencies.notify(changedUserId, detail.id);
      },
      requiredWorkspaceId: workspaceId,
      store: dependencies.store,
    },
    request,
    sessionId,
  );
}
