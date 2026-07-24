import { expect, test } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import {
  WorkspacePanel,
  WorkspaceSwitcher,
  createWorkspaceViewState,
} from "../../solid/workspace-client.tsx";
import { WorkspaceController } from "../../solid/workspace-controller.ts";
import { renderSolidToString } from "./render-solid.tsx";

const LIST = {
  defaultWorkspaceId: "workspace-1",
  workspaces: [
    { id: "workspace-1", isDefault: true, name: "Default" },
    { id: "workspace-2", isDefault: false, name: "Projects" },
  ],
};

test("renders virtual Global selection and ordinary workspace management", () => {
  const controller = new WorkspaceController(
    undefined,
    createReactiveState(createWorkspaceViewState(LIST)),
  );
  const html = renderSolidToString(() => (
    <>
      <WorkspaceSwitcher controller={controller} />
      <WorkspacePanel controller={controller} />
    </>
  ));

  expect(controller.selectedId).toBe(GLOBAL_WORKSPACE_ID);
  expect(html).toContain(">Global</option>");
  expect(html).toContain(">Default</option>");
  expect(html).toContain(">Projects</option>");
  expect(html).toContain("Rename Projects");
  expect(html).toContain('data-workspace-id="workspace-2"');
  expect(html).toContain("Make default");
});
