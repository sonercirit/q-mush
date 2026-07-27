import { Show, type Accessor, type JSX } from "solid-js";
import type { WorkspaceList } from "../shared/workspace-model.ts";

export function renderWithWorkspaces(
  render: (workspaces: Accessor<WorkspaceList | undefined>) => JSX.Element,
  workspaces: Accessor<WorkspaceList | undefined> | undefined,
): JSX.Element {
  return (
    <Show when={workspaces} keyed>
      {(available) => render(available)}
    </Show>
  );
}
