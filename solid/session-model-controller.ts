import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";
import { DiscoveryController } from "./discovery-controller-cache.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readAgentModelCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-controller-state.ts";
import { draftWithModelCatalog } from "./session-form.ts";
import { sessionModelDiscoveryState } from "./session-state.ts";

interface ModelDiscoverySelection {
  readonly credential: NonNullable<
    ReturnType<typeof selectedSessionCredential>
  >;
  readonly value: string;
}

abstract class SessionDiscoveryController<Catalog> extends DiscoveryController<
  SessionViewState,
  Catalog
> {}

export class SessionModelController extends SessionDiscoveryController<AgentModelCatalog> {
  ensure(credentialValue: string, force = false): void {
    const selection = this.#select(credentialValue);
    if (selection === undefined) {
      return;
    }

    const discovery = this.state.value.modelDiscovery;
    if (
      !this.fresh(
        force,
        discovery.credential === selection.value,
        discovery.loading,
        discovery.catalog,
      )
    ) {
      return;
    }

    this.discover(selection.value, force, {
      accept: (catalog) => {
        this.state.patch({
          draft: draftWithModelCatalog(
            this.state.value,
            selection.value,
            catalog,
          ),
          modelDiscovery: sessionModelDiscoveryState(
            selection.value,
            false,
            catalog,
          ),
          openSelect: undefined,
        });
      },
      active: (current) => current.draft.credential === selection.value,
      failed: () => {
        const failedDiscovery = sessionModelDiscoveryState(
          selection.value,
          false,
          undefined,
          "Model discovery failed",
        );
        this.state.patch({ modelDiscovery: failedDiscovery });
      },
      load: async () => {
        const search = new URLSearchParams(selection.credential);
        return readAgentModelCatalog(
          await requestJson(`${SESSION_MODELS_PATH}?${search.toString()}`),
        );
      },
      started: () => {
        this.state.patch({
          modelDiscovery: sessionModelDiscoveryState(selection.value, true),
        });
      },
    });
  }

  #select(value: string): ModelDiscoverySelection | undefined {
    const credential = selectedSessionCredential(value);
    if (credential === undefined) {
      return undefined;
    }

    const current = this.state.value;
    if (current.draft.credential !== value) {
      this.state.replaceSilently({
        ...current,
        draft: Object.assign({}, current.draft, {
          credential: value,
          model: "",
          openRouterProviderTag: "",
          reasoningEffort: "",
        }),
      });
    }
    return { credential, value };
  }
}
