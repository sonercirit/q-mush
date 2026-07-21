import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import {
  createProviderViewState,
  readProviderCredentials,
  type ProviderPanelConfiguration,
  type ProviderViewState,
} from "./provider-client.tsx";
import { providerCredentialDefaultPath } from "./routes.ts";

type ChangeListener = () => void;
type ErrorMessage = (status: number) => string;
type StatePatch = Partial<ProviderViewState>;

function initialProviderState(): ProviderViewState {
  return createProviderViewState(undefined);
}

export class ProviderController {
  readonly #configuration: ProviderPanelConfiguration;
  readonly #onChange: ChangeListener;
  #revision = 0;
  #state: ProviderViewState = initialProviderState();

  constructor(
    configuration: ProviderPanelConfiguration,
    onChange: ChangeListener,
  ) {
    this.#configuration = configuration;
    this.#onChange = onChange;
  }

  get state(): ProviderViewState {
    return this.#state;
  }

  bind(container: Element): void {
    const panel = container.querySelector(
      `[data-provider-panel="${this.#configuration.id}"]`,
    );

    if (panel === null) {
      return;
    }

    const form = panel.querySelector<HTMLFormElement>(
      '[data-action="add-provider-key"]',
    );
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const apiKey = data.get("apiKey");
      const label = data.get("label");

      if (typeof apiKey === "string") {
        void this.#add(apiKey, typeof label === "string" ? label : undefined);
      }
    });

    for (const [action, mutation] of [
      ["set-default-provider-credential", this.#setDefault.bind(this)],
      ["remove-provider-credential", this.#remove.bind(this)],
    ] as const) {
      for (const button of panel.querySelectorAll<HTMLButtonElement>(
        `[data-action="${action}"]`,
      )) {
        button.addEventListener("click", () => {
          const credentialId = button.dataset["credentialId"];
          if (credentialId !== undefined) {
            void mutation(credentialId);
          }
        });
      }
    }

    panel
      .querySelector('[data-action="retry-provider"]')
      ?.addEventListener("click", () => {
        void this.load();
      });
  }

  async load(): Promise<void> {
    const revision = ++this.#revision;
    this.#patch({ credentials: undefined, error: undefined });

    try {
      const credentials = readProviderCredentials(
        await requestJson(this.#configuration.credentialsPath),
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

  reset(): void {
    this.#revision += 1;
    this.#replace(initialProviderState());
  }

  async #add(apiKey: string, label: string | undefined): Promise<void> {
    await this.#mutate(
      this.#configuration.credentialsPath,
      {
        body: JSON.stringify({
          apiKey,
          ...(this.#configuration.keyRequiresLabel === true ? { label } : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      { savePending: true },
      { savePending: false },
      (status) => this.#saveError(status),
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
    this.#replace({ ...this.#state, ...patch });
  }

  #remove(credentialId: string): Promise<void> {
    return this.#mutate(
      `${this.#configuration.credentialsPath}/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
      { removingId: credentialId },
      { removingId: undefined },
      () => `We could not remove that ${this.#configuration.name} credential.`,
    );
  }

  #setDefault(credentialId: string): Promise<void> {
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

  #replace(state: ProviderViewState): void {
    this.#state = state;
    this.#onChange();
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
