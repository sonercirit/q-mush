import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH } from "../shared/routes.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { requestJson } from "./browser-http.ts";
import { createDiscoveryCache } from "./discovery-cache.ts";
import { shouldDiscover } from "./discovery-state.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readAgentModelCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-credential-option.ts";
import { draftWithModelCatalog } from "./session-form.ts";
import { sessionModelDiscoveryState } from "./session-state.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export interface SessionModelController {
  reset(): void;
  ensure(credentialValue: string, force?: boolean): void;
}

export function createSessionModelController(
  state: RevisionState<SessionViewState>,
  transport?: SessionCommandTransport,
): SessionModelController {
  const catalogs = createDiscoveryCache<AgentModelCatalog>();
  const apply = (credential: string, catalog: AgentModelCatalog): void => {
    state.patch({
      draft: draftWithModelCatalog(state.value, credential, catalog),
      modelDiscovery: sessionModelDiscoveryState(credential, false, catalog),
      openSelect: undefined,
    });
  };
  const ensure = (credentialValue: string, force: boolean): void => {
    const applyCached = (key: string, catalog: AgentModelCatalog): void => {
      apply(key, catalog);
    };
    const credential = selectedSessionCredential(credentialValue);
    if (credential === undefined) {
      return;
    }

    if (state.value.draft.credential !== credentialValue) {
      state.replaceSilently({
        ...state.value,
        draft: {
          ...state.value.draft,
          credential: credentialValue,
          model: "",
          openRouterProviderTag: "",
          reasoningEffort: "",
        },
      });
    }

    const discovery = state.value.modelDiscovery;
    if (
      !shouldDiscover({
        currentKey: discovery.credential,
        expectedKey: credentialValue,
        force,
        state: discovery,
      })
    ) {
      return;
    }

    catalogs.begin(credentialValue, force, applyCached, (request) => {
      state.patch({
        modelDiscovery: sessionModelDiscoveryState(credentialValue, true),
      });
      void load(request, credentialValue, credential, applyCached);
    });
  };

  const load = async (
    request: number,
    credentialValue: string,
    credential: NonNullable<ReturnType<typeof selectedSessionCredential>>,
    applyCached: (key: string, catalog: AgentModelCatalog) => void,
  ): Promise<void> => {
    try {
      const catalog = readAgentModelCatalog(
        transport === undefined
          ? await requestJson(
              `${SESSION_MODELS_PATH}?${new URLSearchParams(credential).toString()}`,
            )
          : await transport.command(
              SESSION_REALTIME_OPERATIONS.models,
              credential,
            ),
      );
      catalogs.resolve(
        request,
        credentialValue,
        catalog,
        () => state.value.draft.credential === credentialValue,
        applyCached,
      );
    } catch {
      catalogs.handleFailure(
        request,
        () => state.value.draft.credential === credentialValue,
        () => {
          state.patch({
            modelDiscovery: sessionModelDiscoveryState(
              credentialValue,
              false,
              undefined,
              "Model discovery failed",
            ),
          });
        },
      );
    }
  };
  return {
    reset: () => {
      catalogs.clear();
    },
    ensure: (credentialValue, force = false) => {
      ensure(credentialValue, force);
    },
  };
}
