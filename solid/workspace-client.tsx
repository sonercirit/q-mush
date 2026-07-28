import { For, Show, type Accessor, type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import type { PendingViewState } from "../shared/connection-model.ts";
import {
  GLOBAL_WORKSPACE_ID,
  GLOBAL_WORKSPACE_NAME,
  type WorkspaceList,
  type WorkspaceSummary,
} from "../shared/workspace-model.ts";
import { Collection } from "./collection.tsx";
import { controllerView } from "./controller-view.ts";
import { DefaultableActions } from "./defaultable-actions.tsx";
import { submitFormName } from "./form-handler.ts";
import { renderDebugBoundary } from "./render-debug.tsx";

export interface WorkspaceViewState extends PendingViewState {
  readonly renamingId: string | undefined;
  readonly workspaces: WorkspaceList | undefined;
}

interface WorkspaceControllerProps {
  readonly controller: WorkspacePanelController;
}

export function createWorkspaceViewState(
  workspaces: WorkspaceList | undefined,
): WorkspaceViewState {
  return {
    creating: false,
    error: undefined,
    removingId: undefined,
    renamingId: undefined,
    settingDefaultId: undefined,
    workspaces,
  };
}

function readWorkspace(value: unknown): WorkspaceSummary {
  if (
    !isRecord(value) ||
    typeof value["id"] !== "string" ||
    typeof value["isDefault"] !== "boolean" ||
    typeof value["name"] !== "string"
  ) {
    throw new Error("The server returned an invalid workspace");
  }
  return {
    id: value["id"],
    isDefault: value["isDefault"],
    name: value["name"],
  };
}

export function readWorkspaces(value: unknown): WorkspaceList {
  if (
    !isRecord(value) ||
    typeof value["defaultWorkspaceId"] !== "string" ||
    !Array.isArray(value["workspaces"])
  ) {
    throw new Error("The server returned an invalid workspace list");
  }
  return {
    defaultWorkspaceId: value["defaultWorkspaceId"],
    workspaces: value["workspaces"].map(readWorkspace),
  };
}

function workspaceState(
  props: WorkspaceControllerProps,
): Accessor<WorkspaceViewState> {
  return controllerView(props);
}

export function WorkspaceSwitcher(
  props: WorkspaceControllerProps,
): JSX.Element {
  const state = workspaceState(props);
  const options = (): readonly WorkspaceSummary[] => [
    {
      id: GLOBAL_WORKSPACE_ID,
      isDefault: false,
      name: GLOBAL_WORKSPACE_NAME,
    },
    ...(state().workspaces?.workspaces ?? []),
  ];
  return (
    <label class="flex items-center gap-2 text-sm text-slate-300">
      <span>Workspace</span>
      <select
        class="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white"
        onChange={(event) => {
          props.controller.select(event.currentTarget.value);
        }}
        value={props.controller.selectedIdView()}
      >
        <For each={options()}>
          {(workspace) => (
            <option value={workspace.id}>{workspace.name}</option>
          )}
        </For>
      </select>
    </label>
  );
}

export function WorkspacePanel(props: WorkspaceControllerProps): JSX.Element {
  const state = workspaceState(props);
  return (
    <section
      aria-labelledby="workspaces-title"
      class="rounded-3xl border border-white/10 bg-white/[0.06] p-6 sm:p-8"
      {...renderDebugBoundary("workspaces-panel", "Workspaces panel")}
    >
      <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="text-sm font-medium text-emerald-300">Organization</p>
          <h2
            class="mt-2 text-2xl font-semibold text-white"
            id="workspaces-title"
          >
            Workspaces
          </h2>
          <p class="mt-3 text-slate-400">
            Sessions live in one workspace. Global is a virtual connection
            scope, not a workspace that can hold sessions.
          </p>
        </div>
        <form
          class="flex gap-2"
          onSubmit={(event) => {
            const form = event.currentTarget;
            submitFormName(event, (name) => {
              void props.controller.create(name).then(() => {
                form.reset();
              });
            });
          }}
        >
          <input
            class="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-white"
            maxLength="100"
            name="name"
            placeholder="Workspace name"
            required
          />
          <button
            class="rounded-xl bg-emerald-300 px-4 py-2 font-semibold text-slate-950"
            disabled={state().creating}
            type="submit"
          >
            Add
          </button>
        </form>
      </div>
      <Collection
        empty={<p class="mt-6 text-slate-400">No workspaces.</p>}
        items={state().workspaces?.workspaces}
        listClass="mt-6 space-y-3"
        loading={<p class="mt-6 text-slate-400">Loading workspaces…</p>}
        retry={{
          error: state().error,
          onRetry: () => void props.controller.load(),
        }}
      >
        {(workspace) => (
          <li class="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
            <div class="flex-1">
              <form
                class="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  submitFormName(event, (name) => {
                    void props.controller.rename(workspace.id, name);
                  });
                }}
              >
                <input
                  aria-label={`Rename ${workspace.name}`}
                  class="min-w-0 rounded-xl border border-white/10 bg-slate-900 px-3 py-2 font-semibold text-white"
                  disabled={state().renamingId === workspace.id}
                  maxLength="100"
                  name="name"
                  required
                  value={workspace.name}
                />
                <button
                  class="rounded-xl border border-white/10 px-3 py-2 text-sm font-semibold text-slate-300"
                  disabled={state().renamingId === workspace.id}
                  type="submit"
                >
                  {state().renamingId === workspace.id ? "Renaming…" : "Rename"}
                </button>
              </form>
              <Show when={workspace.id === props.controller.selectedIdView()}>
                <p class="mt-1 text-xs text-cyan-200">Selected</p>
              </Show>
            </div>
            <DefaultableActions
              data={{ "data-workspace-id": workspace.id }}
              isDefault={workspace.isDefault}
              onRemove={() => void props.controller.remove(workspace.id)}
              onSetDefault={() =>
                void props.controller.setDefault(workspace.id)
              }
              removing={state().removingId === workspace.id}
              settingDefault={state().settingDefaultId === workspace.id}
            />
          </li>
        )}
      </Collection>
    </section>
  );
}

interface WorkspacePanelController {
  readonly selectedIdView: Accessor<string>;
  readonly view: Accessor<WorkspaceViewState>;
  create(name: string): Promise<void>;
  load(): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  rename(workspaceId: string, name: string): Promise<void>;
  select(workspaceId: string): void;
  setDefault(workspaceId: string): Promise<void>;
}
