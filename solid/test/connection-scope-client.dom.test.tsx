import { afterEach, expect, test, vi } from "vitest";
import { GLOBAL_WORKSPACE_ID } from "../../shared/workspace-model.ts";
import { ConnectionScopeEditor } from "../connection-scope-client.tsx";
import {
  disposeTestViews,
  mountTestView,
  queryTestElementAs,
} from "./dom-test-helpers.ts";

const disposals: (() => void)[] = [];

function scopeCheckbox(
  container: ParentNode,
  workspaceId: string,
): HTMLInputElement {
  return queryTestElementAs(
    container,
    `input[name='workspaceIds'][value='${workspaceId}']`,
    HTMLInputElement,
  );
}

function disposeScopeEditor(): void {
  disposeTestViews(disposals);
}

afterEach(disposeScopeEditor);

test("switches between global and workspace-specific connection scopes", () => {
  const setScopes = vi.fn<
    (connectionId: string, workspaceIds: readonly string[]) => Promise<void>
  >(() => Promise.resolve());
  const container = mountTestView(
    () => (
      <ConnectionScopeEditor
        connection={{ id: "connection-1", isGlobal: true, workspaceIds: [] }}
        controller={{ setScopes }}
        workspaces={() => ({
          defaultWorkspaceId: "workspace-1",
          workspaces: [{ id: "workspace-1", isDefault: true, name: "Test WS" }],
        })}
      />
    ),
    disposals,
  );
  const global = scopeCheckbox(container, GLOBAL_WORKSPACE_ID);
  const workspace = scopeCheckbox(container, "workspace-1");
  const submit = queryTestElementAs(
    container,
    "button[type='submit']",
    HTMLButtonElement,
  );

  const checkboxStates: boolean[][] = [];
  for (const selected of [workspace, global]) {
    selected.click();
    checkboxStates.push([global.checked, workspace.checked]);
    submit.click();
  }

  expect(checkboxStates).toEqual([
    [false, true],
    [true, false],
  ]);
  expect(setScopes.mock.calls).toEqual([
    ["connection-1", ["workspace-1"]],
    ["connection-1", [GLOBAL_WORKSPACE_ID]],
  ]);
});
