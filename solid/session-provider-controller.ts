import type { OpenRouterProviderCatalog } from "../shared/agent-configuration.ts";
import { SESSION_OPENROUTER_PROVIDERS_PATH } from "../shared/routes.ts";
import { requestJson } from "./browser-http.ts";
import { createDiscoveryCache } from "./discovery-cache.ts";
import { shouldDiscover } from "./discovery-state.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readOpenRouterProviderCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-credential-option.ts";
import { sessionProviderDiscoveryState } from "./session-state.ts";

function discoveryKey(credential: string, model: string): string {
  return `${credential}\n${model}`;
}

export class SessionProviderController {
  readonly #catalogs = createDiscoveryCache<OpenRouterProviderCatalog>();
  readonly #state: RevisionState<SessionViewState>;
  #workspaceId = "";

  constructor(state: RevisionState<SessionViewState>) {
    this.#state = state;
  }

  clear(): void {
    this.#catalogs.delete();
    const draft = this.#state.value.draft;
    if (
      draft.openRouterProviderTag.length > 0 ||
      this.#state.value.providerDiscovery.key !== undefined
    ) {
      this.#state.patch({
        draft: { ...draft, openRouterProviderTag: "" },
        openSelect:
          this.#state.value.openSelect === "openRouterProviderTag"
            ? undefined
            : this.#state.value.openSelect,
        providerDiscovery: sessionProviderDiscoveryState(undefined, false),
      });
    }
  }

  ensure(credentialValue: string, model: string, force = false): void {
    const credential = selectedSessionCredential(credentialValue);
    if (
      credential?.provider !== "openrouter" ||
      model.length === 0 ||
      !this.#matchesDraft(credentialValue, model)
    ) {
      this.clear();
      return;
    }

    const key = discoveryKey(credentialValue, model);
    const discovery = this.#state.value.providerDiscovery;
    if (
      !shouldDiscover({
        currentKey: discovery.key,
        expectedKey: key,
        force,
        state: discovery,
      })
    ) {
      return;
    }
    const applyCached = (
      cachedKey: string,
      catalog: OpenRouterProviderCatalog,
    ): void => {
      this.#apply(cachedKey, catalog);
    };
    this.#catalogs.begin(key, force, applyCached, (request) => {
      this.#state.patch({
        draft: { ...this.#state.value.draft, openRouterProviderTag: "" },
        openSelect: undefined,
        providerDiscovery: sessionProviderDiscoveryState(key, true),
      });
      void this.#load(
        request,
        key,
        credentialValue,
        credential.credentialId,
        model,
      );
    });
  }

  async #load(
    request: number,
    key: string,
    credentialValue: string,
    credentialId: string,
    model: string,
  ): Promise<void> {
    const query = new URLSearchParams({
      credentialId,
      model,
      workspaceId: this.#workspaceId,
    });
    try {
      const catalog = readOpenRouterProviderCatalog(
        await requestJson(
          `${SESSION_OPENROUTER_PROVIDERS_PATH}?${query.toString()}`,
        ),
      );
      this.#catalogs.resolve(
        request,
        key,
        catalog,
        () => this.#matchesDraft(credentialValue, model),
        (resolvedKey, resolvedCatalog) => {
          this.#apply(resolvedKey, resolvedCatalog);
        },
      );
    } catch {
      this.#catalogs.handleFailure(
        request,
        () => this.#matchesDraft(credentialValue, model),
        () => {
          this.#state.patch({
            providerDiscovery: sessionProviderDiscoveryState(
              key,
              false,
              undefined,
              "Serving-provider discovery failed",
            ),
          });
        },
      );
    }
  }

  reset(): void {
    this.#catalogs.clear();
    this.#workspaceId = "";
  }

  setWorkspace(workspaceId: string): void {
    this.#catalogs.clear();
    this.clear();
    this.#workspaceId = workspaceId;
  }

  #apply(key: string, catalog: OpenRouterProviderCatalog): void {
    this.#state.patch({
      openSelect: undefined,
      providerDiscovery: sessionProviderDiscoveryState(key, false, catalog),
    });
  }

  #matchesDraft(credential: string, model: string): boolean {
    const draft = this.#state.value.draft;
    return draft.credential === credential && draft.model === model;
  }
}
