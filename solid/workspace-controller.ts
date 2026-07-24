import { createSignal, type Accessor } from "solid-js";
import { WORKSPACES_PATH, workspaceDefaultPath } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { request, requestJson } from "./browser-http.ts";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import {
  createWorkspaceViewState,
  readWorkspaces,
  type WorkspaceViewState,
} from "./workspace-client.tsx";

export class WorkspaceController {
  readonly #view: ReactiveState<WorkspaceViewState>;
  readonly #onSelected: (workspaceId: string) => void;
  readonly #selectedId: Accessor<string>;
  readonly #setSelectedId: (workspaceId: string) => void;
  #revision = 0;

  constructor(
    onSelected?: (workspaceId: string) => void,
    view = createReactiveState(createWorkspaceViewState(undefined)),
  ) {
    this.#onSelected = onSelected ?? (() => undefined);
    [this.#selectedId, this.#setSelectedId] = createSignal(GLOBAL_WORKSPACE_ID);
    this.#view = view;
  }

  get selectedId(): string {
    return this.#selectedId();
  }

  get selectedIdView(): Accessor<string> {
    return this.#selectedId;
  }

  get state(): WorkspaceViewState {
    return this.#view.state();
  }

  get view(): Accessor<WorkspaceViewState> {
    return this.#view.state;
  }

  async create(name: string): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ creating: true, error: undefined });
    try {
      await request(WORKSPACES_PATH, {
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      if (revision === this.#revision) {
        this.#patch({ creating: false });
        await this.load();
      }
    } catch {
      if (revision === this.#revision) {
        this.#patch({
          creating: false,
          error: "We could not create that workspace.",
        });
      }
    }
  }

  async load(): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ error: undefined, workspaces: undefined });
    try {
      const workspaces = readWorkspaces(await requestJson(WORKSPACES_PATH));
      if (revision !== this.#revision) {
        return;
      }
      this.#patch({ workspaces });
      if (
        this.selectedId === GLOBAL_WORKSPACE_ID ||
        !workspaces.workspaces.some(({ id }) => id === this.selectedId)
      ) {
        this.select(workspaces.defaultWorkspaceId);
      }
    } catch {
      if (revision === this.#revision) {
        this.#patch({ error: "We could not load your workspaces." });
      }
    }
  }

  async remove(workspaceId: string): Promise<void> {
    await this.#mutation(
      `${WORKSPACES_PATH}/${encodeURIComponent(workspaceId)}`,
      "DELETE",
      { removingId: workspaceId },
      "We could not remove that workspace. Remove its sessions and scoped connections first.",
    );
  }

  async rename(workspaceId: string, name: string): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ error: undefined, renamingId: workspaceId });
    try {
      await request(`${WORKSPACES_PATH}/${encodeURIComponent(workspaceId)}`, {
        body: JSON.stringify({ name }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      if (revision === this.#revision) {
        this.#patch({ renamingId: undefined });
        await this.load();
      }
    } catch {
      if (revision === this.#revision) {
        this.#patch({
          error: "We could not rename that workspace.",
          renamingId: undefined,
        });
      }
    }
  }

  reset(): void {
    this.#revision += 1;
    this.#setSelectedId(GLOBAL_WORKSPACE_ID);
    this.#view.setState(createWorkspaceViewState(undefined));
  }

  select(workspaceId: string): void {
    if (workspaceId === this.selectedId) {
      return;
    }
    this.#setSelectedId(workspaceId);
    this.#onSelected(workspaceId);
  }

  async setDefault(workspaceId: string): Promise<void> {
    await this.#mutation(
      workspaceDefaultPath(workspaceId),
      "POST",
      { settingDefaultId: workspaceId },
      "We could not make that workspace the default.",
    );
  }

  async #mutation(
    path: string,
    method: "DELETE" | "POST",
    pending: Partial<WorkspaceViewState>,
    errorMessage: string,
  ): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ ...pending, error: undefined });
    try {
      await request(path, { method });
      if (revision === this.#revision) {
        this.#patch({ removingId: undefined, settingDefaultId: undefined });
        await this.load();
      }
    } catch {
      if (revision === this.#revision) {
        this.#patch({
          error: errorMessage,
          removingId: undefined,
          settingDefaultId: undefined,
        });
      }
    }
  }

  #patch(patch: Partial<WorkspaceViewState>): void {
    this.#view.setState({ ...this.state, ...patch });
  }
}
