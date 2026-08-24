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

export interface SessionProviderController {
  clear(): void;
  ensure(credentialValue: string, model: string, force?: boolean): void;
  reset(): void;
  setWorkspace(workspaceId: string): void;
}

export function createSessionProviderController(
  state: RevisionState<SessionViewState>,
): SessionProviderController {
  const catalogs = createDiscoveryCache<OpenRouterProviderCatalog>();
  let workspaceId = "";
  const matchesDraft = (credential: string, model: string): boolean =>
    state.value.draft.credential === credential &&
    state.value.draft.model === model;
  const apply = (key: string, catalog: OpenRouterProviderCatalog): void => {
    state.patch({
      openSelect: undefined,
      providerDiscovery: sessionProviderDiscoveryState(key, false, catalog),
    });
  };
  async function load(
    request: number,
    key: string,
    credentialValue: string,
    credentialId: string,
    model: string,
  ): Promise<void> {
    const query = new URLSearchParams();
    query.set("credentialId", credentialId);
    query.set("model", model);
    query.set("workspaceId", workspaceId);
    try {
      const catalog = readOpenRouterProviderCatalog(
        await requestJson(
          `${SESSION_OPENROUTER_PROVIDERS_PATH}?${query.toString()}`,
        ),
      );
      catalogs.resolve(
        request,
        key,
        catalog,
        () => matchesDraft(credentialValue, model),
        apply,
      );
    } catch {
      catalogs.handleFailure(
        request,
        () => matchesDraft(credentialValue, model),
        () => {
          state.patch({
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
  const controller: SessionProviderController = {
    clear() {
      catalogs.delete();
      const draft = state.value.draft;
      if (
        draft.openRouterProviderTag.length > 0 ||
        state.value.providerDiscovery.key !== undefined
      )
        state.patch({
          draft: { ...draft, openRouterProviderTag: "" },
          openSelect:
            state.value.openSelect === "openRouterProviderTag"
              ? undefined
              : state.value.openSelect,
          providerDiscovery: sessionProviderDiscoveryState(undefined, false),
        });
    },
    ensure(credentialValue, model, force = false) {
      const credential = selectedSessionCredential(credentialValue);
      if (
        credential?.provider !== "openrouter" ||
        model.length === 0 ||
        !matchesDraft(credentialValue, model)
      ) {
        controller.clear();
        return;
      }
      const key = discoveryKey(credentialValue, model);
      const discovery = state.value.providerDiscovery;
      if (
        !shouldDiscover({
          currentKey: discovery.key,
          expectedKey: key,
          force,
          state: discovery,
        })
      )
        return;
      catalogs.begin(key, force, apply, (request) => {
        state.patch({
          draft: { ...state.value.draft, openRouterProviderTag: "" },
          openSelect: undefined,
          providerDiscovery: sessionProviderDiscoveryState(key, true),
        });
        void load(
          request,
          key,
          credentialValue,
          credential.credentialId,
          model,
        );
      });
    },
    reset() {
      catalogs.clear();
      workspaceId = "";
    },
    setWorkspace(nextWorkspaceId) {
      catalogs.clear();
      controller.clear();
      workspaceId = nextWorkspaceId;
    },
  };
  return controller;
}
