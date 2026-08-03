import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import { SESSION_MODELS_PATH } from "../shared/routes.ts";
import { SESSION_REALTIME_OPERATIONS } from "../shared/user-realtime-protocol.ts";
import { requestJson } from "./browser-http.ts";
import { DiscoveryCache } from "./discovery-cache.ts";
import { shouldDiscover } from "./discovery-state.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { readAgentModelCatalog } from "./session-codec.ts";
import { selectedSessionCredential } from "./session-credential-option.ts";
import { draftWithModelCatalog } from "./session-form.ts";
import { sessionModelDiscoveryState } from "./session-state.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export class SessionModelController {
  readonly #catalogs = new DiscoveryCache<AgentModelCatalog>();
  readonly #state: RevisionState<SessionViewState>;
  readonly #transport: SessionCommandTransport | undefined;

  constructor(
    state: RevisionState<SessionViewState>,
    transport?: SessionCommandTransport,
  ) {
    this.#state = state;
    this.#transport = transport;
  }

  reset(): void {
    this.#catalogs.clear();
  }

  ensure(credentialValue: string, force = false): void {
    this.#ensure(credentialValue, force);
  }

  #ensure(credentialValue: string, force: boolean): void {
    const applyCached = (key: string, catalog: AgentModelCatalog): void => {
      this.#apply(key, catalog);
    };
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
          openRouterProviderTag: "",
          reasoningEffort: "",
        },
      });
    }

    const discovery = this.#state.value.modelDiscovery;
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

    this.#catalogs.begin(credentialValue, force, applyCached, (request) => {
      this.#state.patch({
        modelDiscovery: sessionModelDiscoveryState(credentialValue, true),
      });
      void this.#load(request, credentialValue, credential, applyCached);
    });
  }

  async #load(
    request: number,
    credentialValue: string,
    credential: NonNullable<ReturnType<typeof selectedSessionCredential>>,
    applyCached: (key: string, catalog: AgentModelCatalog) => void,
  ): Promise<void> {
    try {
      const catalog = readAgentModelCatalog(
        this.#transport === undefined
          ? await requestJson(
              `${SESSION_MODELS_PATH}?${new URLSearchParams(credential).toString()}`,
            )
          : await this.#transport.command(
              SESSION_REALTIME_OPERATIONS.models,
              credential,
            ),
      );
      this.#catalogs.resolve(
        request,
        credentialValue,
        catalog,
        () => this.#state.value.draft.credential === credentialValue,
        applyCached,
      );
    } catch {
      this.#catalogs.handleFailure(
        request,
        () => this.#state.value.draft.credential === credentialValue,
        () => {
          this.#state.patch({
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
  }

  #apply(credential: string, catalog: AgentModelCatalog): void {
    this.#state.patch({
      draft: draftWithModelCatalog(this.#state.value, credential, catalog),
      modelDiscovery: sessionModelDiscoveryState(credential, false, catalog),
      openSelect: undefined,
    });
  }
}
