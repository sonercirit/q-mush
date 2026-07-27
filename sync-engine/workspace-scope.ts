import { isWorkspaceId } from "../shared/workspace-model.ts";

export function workspaceScopeIsValid(
  workspaceId: string | undefined,
  userId: string,
  validateScopes: (userId: string, workspaceIds: readonly string[]) => boolean,
): workspaceId is string {
  return (
    workspaceId !== undefined &&
    isWorkspaceId(workspaceId) &&
    validateScopes(userId, [workspaceId])
  );
}
