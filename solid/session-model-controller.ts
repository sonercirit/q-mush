import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { requestJson } from "./browser-http.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readAgentModelCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-controller-state.ts";
import { draftWithModelCatalog } from "./session-form.ts";
import { sessionModelDiscoveryState } from "./session-state.ts";

export class SessionModelController {
  readonly #catalogs = new Map<string, AgentModelCatalog>();
  #request = 0;
  #workspaceId = GLOBAL_WORKSPACE_ID;
  readonly #state: RevisionState<SessionViewState>;

  constructor(state: RevisionState<SessionViewState>) {
    this.#state = state;
  }

  reset(): void {
    this.#workspaceId = GLOBAL_WORKSPACE_ID;
    this.#catalogs.clear();
    this.#request += 1;
  }

  setWorkspace(workspaceId: string): void {
    this.reset();
    this.#workspaceId = workspaceId;
  }

  ensure(credentialValue: string, force = false): void {
    void this.#ensure(credentialValue, force);
  }

  async #ensure(credentialValue: string, force: boolean): Promise<void> {
    const credential = selectedSessionCredential(credentialValue);
    if (credential === undefined) {
      return;
    }

    if (this.#state.value.draft.credential !== credentialValue) {
      this.#state.replaceSilently({
        ...this.#state.value,
        draft: {
          ...this.#state.value.draft,
          credential: credentialValue,
          model: "",
          reasoningEffort: "",
        },
      });
    }

    const discovery = this.#state.value.modelDiscovery;
    if (
      !force &&
      discovery.credential === credentialValue &&
      (discovery.loading || discovery.catalog !== undefined)
    ) {
      return;
    }

    const cached = force ? undefined : this.#catalogs.get(credentialValue);
    if (cached !== undefined) {
      this.#apply(credentialValue, cached);
      return;
    }

    const request = (this.#request += 1);
    this.#state.patch({
      modelDiscovery: sessionModelDiscoveryState(credentialValue, true),
    });

    try {
      const search = new URLSearchParams({
        ...credential,
        workspaceId: this.#workspaceId,
      });
      const catalog = readAgentModelCatalog(
        await requestJson(`${SESSION_MODELS_PATH}?${search.toString()}`),
      );
      if (
        request !== this.#request ||
        this.#state.value.draft.credential !== credentialValue
      ) {
        return;
      }

      this.#catalogs.set(credentialValue, catalog);
      this.#apply(credentialValue, catalog);
    } catch {
      if (
        request === this.#request &&
        this.#state.value.draft.credential === credentialValue
      ) {
        this.#state.patch({
          modelDiscovery: sessionModelDiscoveryState(
            credentialValue,
            false,
            undefined,
            "Model discovery failed",
          ),
        });
      }
    }
  }

  #apply(credential: string, catalog: AgentModelCatalog): void {
    this.#state.patch({
      draft: draftWithModelCatalog(this.#state.value, credential, catalog),
      modelDiscovery: sessionModelDiscoveryState(credential, false, catalog),
      openSelect: undefined,
    });
  }
}
