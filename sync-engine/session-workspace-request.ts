import type { AuthenticatedUser } from "../shared/auth-model.ts";
import type { SessionRequestHelpers } from "./session-request-helpers.ts";
import {
  withRequestSessionWorkspace,
  type SessionWorkspaceReader,
} from "./session-workspace.ts";

export function forRequestWorkspace<
  Result extends Promise<Response> | Response,
>(
  requests: Pick<SessionRequestHelpers, "forUser">,
  workspaces: SessionWorkspaceReader,
  request: Request,
  action: (user: AuthenticatedUser, workspaceId: string) => Result,
): Response | Result {
  return requests.forUser(request, (user) =>
    withRequestSessionWorkspace(request, user, workspaces, (workspaceId) =>
      action(user, workspaceId),
    ),
  );
}
