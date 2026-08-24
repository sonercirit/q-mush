import { createSignal, type Accessor } from "solid-js";
import { WORKSPACES_PATH, workspaceDefaultPath } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { request, requestJson } from "./browser-http.ts";
import { ControllerState, jsonRequestInit } from "./controller-mutation.ts";
import { createReactiveState } from "./reactive-state.ts";
import {
  createWorkspaceViewState,
  readWorkspaces,
  type WorkspaceViewState,
} from "./workspace-client.tsx";

export interface WorkspaceController {
  readonly selectedId: string;
  readonly selectedIdView: Accessor<string>;
  readonly state: WorkspaceViewState;
  readonly view: Accessor<WorkspaceViewState>;
  create(name: string): Promise<void>;
  load(): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  rename(workspaceId: string, name: string): Promise<void>;
  reset(): void;
  select(workspaceId: string): void;
  setDefault(workspaceId: string): Promise<void>;
}

export function createWorkspaceController(
  onSelected: (workspaceId: string) => void = () => undefined,
  view = createReactiveState(createWorkspaceViewState(undefined)),
): WorkspaceController {
  const [selectedId, setSelectedId] = createSignal(GLOBAL_WORKSPACE_ID);
  const state = new ControllerState(view);
  const load = async (): Promise<void> => {
    const result = await state.load({
      failure: () => ({ error: "We could not load your workspaces." }),
      pending: { error: undefined, workspaces: undefined },
      request: () => requestJson(WORKSPACES_PATH),
      success: (value) => ({ workspaces: readWorkspaces(value) }),
    });
    const workspaces =
      result === undefined ? undefined : readWorkspaces(result);
    if (
      workspaces !== undefined &&
      (selectedId() === GLOBAL_WORKSPACE_ID ||
        !workspaces.workspaces.some(({ id }) => id === selectedId()))
    ) {
      controller.select(workspaces.defaultWorkspaceId);
    }
  };
  const requestAndReload = async (
    path: string,
    init: RequestInit,
    pending: Partial<WorkspaceViewState>,
    settled: Partial<WorkspaceViewState>,
    errorMessage: string,
  ): Promise<void> => {
    await state.mutation(
      path,
      init,
      request,
      () => ({ ...settled, error: errorMessage }),
      { ...pending, error: undefined },
      settled,
      load,
    );
  };
  const update = async (
    workspaceId: string,
    name: string | undefined,
  ): Promise<void> => {
    await requestAndReload(
      `${WORKSPACES_PATH}/${encodeURIComponent(workspaceId)}`,
      name === undefined
        ? { method: "DELETE" }
        : jsonRequestInit({ name }, "PATCH"),
      name === undefined
        ? { removingId: workspaceId }
        : { renamingId: workspaceId },
      name === undefined
        ? { removingId: undefined, settingDefaultId: undefined }
        : { renamingId: undefined },
      name === undefined
        ? "We could not remove that workspace. Remove its sessions and scoped connections first."
        : "We could not rename that workspace.",
    );
  };
  const controller: WorkspaceController = {
    get selectedId() {
      return selectedId();
    },
    selectedIdView: selectedId,
    get state() {
      return state.value;
    },
    view: state.accessor,
    async create(name) {
      await requestAndReload(
        WORKSPACES_PATH,
        jsonRequestInit({ name }, "POST"),
        { creating: true },
        { creating: false },
        "We could not create that workspace.",
      );
    },
    load,
    remove: (workspaceId) => update(workspaceId, undefined),
    rename: (workspaceId, name) => update(workspaceId, name),
    reset() {
      state.revision.advance();
      setSelectedId(GLOBAL_WORKSPACE_ID);
      state.replace(createWorkspaceViewState(undefined));
    },
    select(workspaceId) {
      if (workspaceId !== selectedId()) {
        setSelectedId(workspaceId);
        onSelected(workspaceId);
      }
    },
    async setDefault(workspaceId) {
      await requestAndReload(
        workspaceDefaultPath(workspaceId),
        { method: "POST" },
        { settingDefaultId: workspaceId },
        { removingId: undefined, settingDefaultId: undefined },
        "We could not make that workspace the default.",
      );
    },
  };
  return controller;
}
