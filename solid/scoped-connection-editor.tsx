import { type Accessor, type JSX } from "solid-js";
import type { ScopedConnectionSummary } from "../shared/connection-model.ts";
import type { WorkspaceList } from "../shared/workspace-model.ts";
import {
  ConnectionScopeEditor,
  type ConnectionScopeController,
} from "./connection-scope-client.tsx";
import { renderWithWorkspaces } from "./scoped-connection-client.tsx";

export function ScopedConnectionEditor(props: {
  readonly connection: ScopedConnectionSummary;
  readonly controller: ConnectionScopeController;
  readonly workspaces: Accessor<WorkspaceList | undefined> | undefined;
}): JSX.Element {
  return renderWithWorkspaces(
    (workspaces) => (
      <ConnectionScopeEditor
        connection={props.connection}
        controller={props.controller}
        workspaces={workspaces}
      />
    ),
    () => props.workspaces,
  );
}
