import { expect, test } from "vitest";
import { TEST_WORKSPACE_LIST } from "../../shared/test/workspace-fixtures.ts";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import {
  WorkspacePanel,
  WorkspaceSwitcher,
  createWorkspaceViewState,
} from "../../solid/workspace-client.tsx";
import { WorkspaceController } from "../../solid/workspace-controller.ts";
import { renderSolidToString } from "./render-solid.tsx";

const LIST = TEST_WORKSPACE_LIST;

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
