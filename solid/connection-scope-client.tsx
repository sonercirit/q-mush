import { For, Show, type Accessor, type JSX } from "solid-js";
import {
  GLOBAL_WORKSPACE_ID,
  GLOBAL_WORKSPACE_NAME,
  type WorkspaceList,
} from "../shared/workspace-model.ts";

export interface ConnectionScopeController {
  setScopes(
    connectionId: string,
    workspaceIds: readonly string[],
  ): Promise<void>;
}

interface ScopedConnection {
  readonly id: string;
  readonly isGlobal?: boolean;
  readonly workspaceIds?: readonly string[];
}

export function ConnectionScopeEditor(props: {
  readonly connection: ScopedConnection;
  readonly controller: ConnectionScopeController;
  readonly workspaces: Accessor<WorkspaceList | undefined>;
}): JSX.Element {
  const selected = (workspaceId: string): boolean =>
    workspaceId === GLOBAL_WORKSPACE_ID
      ? props.connection.isGlobal === true
      : props.connection.workspaceIds?.includes(workspaceId) === true;

  return (
    <form
      class="mt-3 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const workspaceIds = new FormData(event.currentTarget)
          .getAll("workspaceIds")
          .map(String);
        if (workspaceIds.includes(GLOBAL_WORKSPACE_ID)) {
          void props.controller.setScopes(props.connection.id, [
            GLOBAL_WORKSPACE_ID,
          ]);
        } else if (workspaceIds.length > 0) {
          void props.controller.setScopes(props.connection.id, workspaceIds);
        }
      }}
    >
      <fieldset class="flex flex-wrap gap-3">
        <legend class="mb-2 text-xs font-medium text-slate-400">
          Available in
        </legend>
        <label class="flex items-center gap-2 text-xs text-slate-300">
          <input
            checked={selected(GLOBAL_WORKSPACE_ID)}
            name="workspaceIds"
            type="checkbox"
            value={GLOBAL_WORKSPACE_ID}
          />
          {GLOBAL_WORKSPACE_NAME}
        </label>
        <For each={props.workspaces()?.workspaces ?? []}>
          {(workspace) => (
            <label class="flex items-center gap-2 text-xs text-slate-300">
              <input
                checked={selected(workspace.id)}
                name="workspaceIds"
                type="checkbox"
                value={workspace.id}
              />
              {workspace.name}
            </label>
          )}
        </For>
      </fieldset>
      <Show when={props.workspaces() !== undefined}>
        <button
          class="rounded-lg border border-cyan-300/20 px-3 py-1.5 text-xs font-semibold text-cyan-200"
          type="submit"
        >
          Save scope
        </button>
      </Show>
    </form>
  );
}
