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

export class WorkspaceController {
  readonly #onSelected: (workspaceId: string) => void;
  readonly #state: ControllerState<WorkspaceViewState>;
  readonly #selectedId: Accessor<string>;
  readonly #setSelectedId: (workspaceId: string) => void;

  constructor(
    onSelected?: (workspaceId: string) => void,
    view = createReactiveState(createWorkspaceViewState(undefined)),
  ) {
    this.#onSelected = onSelected ?? (() => undefined);
    [this.#selectedId, this.#setSelectedId] = createSignal(GLOBAL_WORKSPACE_ID);
    this.#state = new ControllerState(view);
  }

  get selectedId(): string {
    return this.#selectedId();
  }

  get selectedIdView(): Accessor<string> {
    return this.#selectedId;
  }

  get state(): WorkspaceViewState {
    return this.#state.value;
  }

  get view(): Accessor<WorkspaceViewState> {
    return this.#state.accessor;
  }

  async create(name: string): Promise<void> {
    await this.#requestAndReload(
      WORKSPACES_PATH,
      jsonRequestInit({ name }, "POST"),
      { creating: true },
      { creating: false },
      "We could not create that workspace.",
    );
  }

  async load(): Promise<void> {
    const result = await this.#state.load({
      failure: () => ({ error: "We could not load your workspaces." }),
      pending: { error: undefined, workspaces: undefined },
      request: () => requestJson(WORKSPACES_PATH),
      success: (value) => ({ workspaces: readWorkspaces(value) }),
    });
    const workspaces =
      result === undefined ? undefined : readWorkspaces(result);
    if (
      workspaces !== undefined &&
      (this.selectedId === GLOBAL_WORKSPACE_ID ||
        !workspaces.workspaces.some(({ id }) => id === this.selectedId))
    ) {
      this.select(workspaces.defaultWorkspaceId);
    }
  }

  async #update(workspaceId: string, name: string | undefined): Promise<void> {
    await this.#requestAndReload(
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
  }

  async remove(workspaceId: string): Promise<void> {
    await this.#update(workspaceId, undefined);
  }

  async rename(workspaceId: string, name: string): Promise<void> {
    await this.#update(workspaceId, name);
  }

  reset(): void {
    this.#state.revision.advance();
    this.#setSelectedId(GLOBAL_WORKSPACE_ID);
    this.#state.replace(createWorkspaceViewState(undefined));
  }

  select(workspaceId: string): void {
    if (workspaceId === this.selectedId) {
      return;
    }
    this.#setSelectedId(workspaceId);
    this.#onSelected(workspaceId);
  }

  async setDefault(workspaceId: string): Promise<void> {
    await this.#requestAndReload(
      workspaceDefaultPath(workspaceId),
      { method: "POST" },
      { settingDefaultId: workspaceId },
      { removingId: undefined, settingDefaultId: undefined },
      "We could not make that workspace the default.",
    );
  }

  async #requestAndReload(
    path: string,
    init: RequestInit,
    pending: Partial<WorkspaceViewState>,
    settled: Partial<WorkspaceViewState>,
    errorMessage: string,
  ): Promise<void> {
    await this.#state.mutation(
      path,
      init,
      request,
      () => ({ ...settled, error: errorMessage }),
      { ...pending, error: undefined },
      settled,
      () => this.load(),
    );
  }
}
