import { type Accessor } from "solid-js";
import {
  providerCredentialDefaultPath,
  providerCredentialSessionReassignmentPath,
} from "../shared/routes.ts";
import { readSessionCredentialReassignmentResult } from "../shared/session-credential-reassignment.ts";
import { HttpResponseError, request, requestJson } from "./browser-http.ts";
import {
  createProviderViewState,
  readProviderCredentials,
  type ProviderPanelConfiguration,
  type ProviderViewState,
} from "./provider-client.tsx";
import { createReactiveState, type ReactiveState } from "./reactive-state.ts";
import type { SessionReassignmentDialogController } from "./session-reassignment-dialog-controller.ts";

type ErrorMessage = (status: number) => string;
type StatePatch = Partial<ProviderViewState>;

function initialProviderState(): ProviderViewState {
  return createProviderViewState(undefined);
}

export class ProviderController {
  readonly #configuration: ProviderPanelConfiguration;
  readonly #view: ReactiveState<ProviderViewState>;
  #pendingSessionReassignment:
    | {
        readonly dialog: SessionReassignmentDialogController;
        readonly revision: number;
      }
    | undefined;
  #revision = 0;

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
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      { savePending: true },
      { savePending: false },
      (status) => this.#saveError(status),
    );
  }

  async confirmSessionReassignment(
    dialog: SessionReassignmentDialogController,
  ): Promise<void> {
    const state = dialog.state;
    if (state === undefined || state.pending) {
      return;
    }

    const revision = this.#revision;
    this.#pendingSessionReassignment = { dialog, revision };
    dialog.pending();
    try {
      const result = readSessionCredentialReassignmentResult(
        await requestJson(
          providerCredentialSessionReassignmentPath(
            this.#configuration.credentialsPath,
            state.credential.id,
          ),
          {
            body: "{}",
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      const count = result.migratedSessionCount;
      dialog.succeeded();
      if (revision === this.#revision) {
        this.#patch({
          sessionReassignmentNotice:
            count === 0
              ? "No sessions needed switching; they already use this account."
              : `${String(count)} ${count === 1 ? "session" : "sessions"} switched to this account.`,
        });
      }
    } catch {
      if (revision === this.#revision) {
        dialog.failed(
          `We could not switch your ${this.#configuration.name} sessions. Please try again.`,
        );
      } else {
        dialog.succeeded();
      }
    } finally {
      if (
        revision === this.#revision &&
        this.#pendingSessionReassignment.revision === revision
      ) {
        this.#pendingSessionReassignment = undefined;
      }
    }
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
    this.#pendingSessionReassignment?.dialog.reset();
    this.#pendingSessionReassignment = undefined;
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
