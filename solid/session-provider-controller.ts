import type { OpenRouterProviderCatalog } from "../shared/agent-configuration.ts";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";
import { DiscoveryController } from "./discovery-controller-cache.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readOpenRouterProviderCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-controller-state.ts";
import { sessionProviderDiscoveryState } from "./session-state.ts";

function discoveryKey(credential: string, model: string): string {
  return `${credential}\n${model}`;
}

export class SessionProviderController extends DiscoveryController<
  SessionViewState,
  OpenRouterProviderCatalog
> {
  constructor(state: RevisionState<SessionViewState>) {
    const sessionState = state;
    super(sessionState);
  }

  ensure(credentialValue: string, model: string, force = false): void {
    const credential = selectedSessionCredential(credentialValue);
    if (
      credential?.provider !== "openrouter" ||
      !this.#matchesDraft(credentialValue, model)
    ) {
      this.clear();
      return;
    }

    const key = discoveryKey(credentialValue, model);
    const discovery = this.state.value.providerDiscovery;
    if (
      !this.fresh(
        force,
        discovery.key === key,
        discovery.loading,
        discovery.catalog,
      )
    ) {
      return;
    }

    this.discover(key, force, {
      accept: (catalog) => {
        this.state.patch({
          openSelect: undefined,
          providerDiscovery: sessionProviderDiscoveryState(key, false, catalog),
        });
      },
      active: () => this.#matchesDraft(credentialValue, model),
      failed: () => {
        const failedDiscovery = sessionProviderDiscoveryState(
          key,
          false,
          undefined,
          "Serving-provider discovery failed",
        );
        this.state.patch({ providerDiscovery: failedDiscovery });
      },
      load: async () => {
        const query = new URLSearchParams();
        query.set("credentialId", credential.credentialId);
        query.set("model", model);
        const value = await requestJson(
          `${SESSION_OPENROUTER_PROVIDERS_PATH}?${query.toString()}`,
        );
        return readOpenRouterProviderCatalog(value);
      },
      started: () => {
        this.state.patch({
          draft: this.#draftWithoutProvider(),
          openSelect: undefined,
          providerDiscovery: sessionProviderDiscoveryState(key, true),
        });
      },
    });
  }

  clear(): void {
    this.invalidate();
    const discoveryActive =
      this.state.value.providerDiscovery.key !== undefined;
    const providerSelected =
      this.state.value.draft.openRouterProviderTag.length > 0;
    if (providerSelected || discoveryActive) {
      const openSelect =
        this.state.value.openSelect === "openRouterProviderTag"
          ? undefined
          : this.state.value.openSelect;
      this.state.patch({
        draft: this.#draftWithoutProvider(),
        openSelect,
        providerDiscovery: sessionProviderDiscoveryState(undefined, false),
      });
    }
  }

  #draftWithoutProvider(): SessionViewState["draft"] {
    return { ...this.state.value.draft, openRouterProviderTag: "" };
  }

  #matchesDraft(credential: string, model: string): boolean {
    const draft = this.state.value.draft;
    return (
      model.length > 0 &&
      draft.credential === credential &&
      draft.model === model
    );
  }
}
