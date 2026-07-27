import type { WorkspaceList } from "../workspace-model.ts";

export const TEST_WORKSPACE_LIST: WorkspaceList = {
  defaultWorkspaceId: "workspace-1",
  workspaces: [
    { id: "workspace-1", isDefault: true, name: "Default" },
    { id: "workspace-2", isDefault: false, name: "Projects" },
  ],
};
