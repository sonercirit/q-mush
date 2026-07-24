import { type Accessor } from "solid-js";
import {
  connectionScopesPath,
  providerCredentialDefaultPath,
} from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import {
  createProviderViewState,
  readProviderCredentials,
  type ProviderPanelConfiguration,
  type ProviderViewState,
} from "./provider-client.tsx";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";

type ErrorMessage = (status: number) => string;
type StatePatch = Partial<ProviderViewState>;

function initialProviderState(): ProviderViewState {
  return createProviderViewState(undefined);
}

export class ProviderController {
  readonly #configuration: ProviderPanelConfiguration;
  readonly #view: ReactiveState<ProviderViewState>;
  #revision = 0;
  #workspaceId = GLOBAL_WORKSPACE_ID;

  constructor(
    configuration: ProviderPanelConfiguration,
    view = createReactiveState(initialProviderState()),
  ) {
    this.#configuration = configuration;
    this.#view = view;
  }

  get state(): ProviderViewState {
    return this.#view.state();
  }

  get view(): Accessor<ProviderViewState> {
    return this.#view.state;
  }

  async add(apiKey: string, label?: string): Promise<void> {
    await this.#mutate(
      this.#configuration.credentialsPath,
      {
        body: JSON.stringify({
          apiKey,
          ...(this.#configuration.keyRequiresLabel === true ? { label } : {}),
          workspaceIds: [this.#workspaceId],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      { savePending: true },
      { savePending: false },
      (status) => this.#saveError(status),
    );
  }

  async load(): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ credentials: undefined, error: undefined });

    try {
      const credentials = readProviderCredentials(
        await requestJson(
          `${this.#configuration.credentialsPath}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
        ),
        this.#configuration.name,
      );

      if (revision === this.#revision) {
        this.#patch({ credentials, error: undefined });
      }
    } catch (error) {
      if (revision === this.#revision) {
        this.#patch({
          error:
            error instanceof HttpResponseError
              ? this.#loadError(error.status)
              : this.#loadError(0),
        });
      }
    }
  }

  remove(credentialId: string): Promise<void> {
    return this.#mutate(
      `${this.#configuration.credentialsPath}/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
      { removingId: credentialId },
      { removingId: undefined },
      () => `We could not remove that ${this.#configuration.name} credential.`,
    );
  }

  reset(): void {
    this.#revision += 1;
    this.#workspaceId = GLOBAL_WORKSPACE_ID;
    this.#replace(initialProviderState());
  }

  setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void> {
    return this.#mutate(
      connectionScopesPath(this.#configuration.credentialsPath, credentialId),
      {
        body: JSON.stringify({ workspaceIds }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
      {},
      {},
      () => `We could not update that ${this.#configuration.name} scope.`,
    );
  }

  setWorkspace(workspaceId: string): void {
    this.#workspaceId = workspaceId;
    this.#revision += 1;
    this.#replace(initialProviderState());
  }

  setDefault(credentialId: string): Promise<void> {
    return this.#mutate(
      providerCredentialDefaultPath(
        this.#configuration.credentialsPath,
        credentialId,
      ),
      { method: "POST" },
      { settingDefaultId: credentialId },
      { settingDefaultId: undefined },
      () =>
        `We could not make that ${this.#configuration.name} credential the default.`,
    );
  }

  #configurationError(): string {
    const variable =
      this.#configuration.id === "brave-search"
        ? "BRAVE_SEARCH_CREDENTIAL_KEY"
        : `${this.#configuration.id.toUpperCase()}_CREDENTIAL_KEY`;
    return `${this.#configuration.name} storage is not configured. Set ${variable} on the local server and restart it.`;
  }

  #loadError(status: number): string {
    return status === 503
      ? this.#configurationError()
      : `We could not load your ${this.#configuration.name} credentials. Please try again.`;
  }

  async #mutate(
    input: RequestInfo | URL,
    init: RequestInit,
    pending: StatePatch,
    settled: StatePatch,
    errorMessage: ErrorMessage,
  ): Promise<void> {
    const revision = this.#revision;
    this.#patch({ ...pending, error: undefined });

    try {
      await request(input, init);

      if (revision === this.#revision) {
        this.#patch(settled);
        await this.load();
      }
    } catch (error) {
      if (revision === this.#revision) {
        const status = error instanceof HttpResponseError ? error.status : 0;
        this.#patch({ ...settled, error: errorMessage(status) });
      }
    }
  }

  #patch(patch: StatePatch): void {
    this.#replace({ ...this.state, ...patch });
  }

  #replace(state: ProviderViewState): void {
    this.#view.setState(state);
  }

  #saveError(status: number): string {
    if (status === 400) {
      return `${this.#configuration.name} rejected that API key. Check it and try again.`;
    }

    if (status === 409) {
      return `That ${this.#configuration.name} credential is already saved.`;
    }

    return status === 503
      ? this.#configurationError()
      : `We could not add that ${this.#configuration.name} API key. Please try again.`;
  }
}
