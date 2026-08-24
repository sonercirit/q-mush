import { type Accessor } from "solid-js";
import type { ProviderQuotaResetOutcome } from "../shared/provider-quota.ts";
import {
  connectionScopesPath,
  providerCredentialDefaultPath,
  providerCredentialQuotaPath,
  providerCredentialQuotaResetPath,
  providerCredentialQuotaThresholdPath,
  providerCredentialSessionReassignmentPath,
} from "../shared/routes.ts";
import { readSessionCredentialReassignmentResult } from "../shared/session-credential-reassignment.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import { isHttpResponseError, request, requestJson } from "./browser-http.ts";
import { ControllerState, jsonRequestInit } from "./controller-mutation.ts";
import {
  createProviderViewState,
  readProviderCredentials,
  type ProviderCredentialAddInput,
  type ProviderViewState,
} from "./provider-credential-model.ts";
import { type ProviderPanelConfiguration } from "./provider-panel-configuration.ts";
import {
  readProviderQuota,
  readQuotaResetResult,
} from "./provider-quota-client.tsx";
import { createReactiveState } from "./reactive-state.ts";
import type { SessionReassignmentDialogController } from "./session-reassignment-dialog-controller.ts";

type ErrorMessage = (status: number) => string;
type StatePatch = Partial<ProviderViewState>;

function initialProviderState(): ProviderViewState {
  return createProviderViewState(undefined);
}

export class ProviderController {
  readonly #configuration: ProviderPanelConfiguration;
  readonly #quotaResetRequestIds = new Map<string, string>();
  readonly #state: ControllerState<ProviderViewState>;
  #pendingSessionReassignment:
    | {
        readonly dialog: SessionReassignmentDialogController;
        readonly revision: number;
      }
    | undefined;
  #workspaceId = GLOBAL_WORKSPACE_ID;

  constructor(
    configuration: ProviderPanelConfiguration,
    view = createReactiveState(initialProviderState()),
  ) {
    this.#configuration = configuration;
    this.#state = new ControllerState(view);
  }

  get state(): ProviderViewState {
    return this.#state.value;
  }

  get view(): Accessor<ProviderViewState> {
    return this.#state.accessor;
  }

  async add(
    ...[apiKey, label, baseUrl, apiFormat]: ProviderCredentialAddInput
  ): Promise<void> {
    await this.#mutate(
      this.#configuration.credentialsPath,
      jsonRequestInit(
        {
          ...(this.#configuration.apiFormatSelectable === true &&
          apiFormat !== undefined
            ? { apiFormat }
            : {}),
          apiKey,
          ...(this.#configuration.baseUrlPlaceholder === undefined
            ? {}
            : { baseUrl }),
          ...(this.#configuration.keyRequiresLabel === true ? { label } : {}),
          workspaceIds: [this.#workspaceId],
        },
        "POST",
      ),
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

    const revision = this.#state.revision.value();
    const pending = { dialog, revision };
    this.#pendingSessionReassignment = pending;
    dialog.pending();
    try {
      const result = readSessionCredentialReassignmentResult(
        await requestJson(
          `${providerCredentialSessionReassignmentPath(
            this.#configuration.credentialsPath,
            state.credential.id,
          )}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
          {
            body: JSON.stringify(
              this.#workspaceId === GLOBAL_WORKSPACE_ID
                ? {}
                : { workspaceId: this.#workspaceId },
            ),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      const count = result.migratedSessionCount;
      dialog.succeeded();
      if (this.#state.revision.isCurrent(revision)) {
        this.#state.patch({
          sessionReassignmentNotice:
            count === 0
              ? "No sessions needed switching; they already use this account."
              : `${String(count)} ${count === 1 ? "session" : "sessions"} switched to this account.`,
        });
      }
    } catch {
      if (this.#state.revision.isCurrent(revision)) {
        dialog.failed(
          `We could not switch your ${this.#configuration.name} sessions. Please try again.`,
        );
      } else {
        dialog.succeeded();
      }
    } finally {
      if (
        this.#state.revision.isCurrent(revision) &&
        this.#pendingSessionReassignment === pending
      ) {
        this.#pendingSessionReassignment = undefined;
      }
    }
  }

  async load(): Promise<void> {
    await this.#state.load({
      failure: (error) => ({
        error: isHttpResponseError(error)
          ? this.#loadError(error.status)
          : this.#loadError(0),
      }),
      pending: { credentials: undefined, error: undefined },
      request: () =>
        requestJson(
          `${this.#configuration.credentialsPath}?workspaceId=${encodeURIComponent(this.#workspaceId)}`,
        ),
      success: (value) => {
        const credentials = readProviderCredentials(
          value,
          this.#configuration.name,
        );
        return {
          credentials,
          error: undefined,
          quotaLoadingIds:
            this.#configuration.id === "brave-search" ||
            this.#configuration.quotaSupported === false
              ? []
              : credentials.map(({ id }) => id),
        };
      },
    });
    if (
      this.#configuration.id !== "brave-search" &&
      this.#configuration.quotaSupported !== false
    ) {
      await Promise.all(
        this.state.quotaLoadingIds.map((credentialId) =>
          this.loadQuota(credentialId),
        ),
      );
    }
  }

  async loadQuota(credentialId: string): Promise<void> {
    const loading = new Set(this.state.quotaLoadingIds);
    loading.add(credentialId);
    this.#state.patch({ quotaLoadingIds: [...loading] });
    const settle = (): void => {
      this.#state.patch({
        quotaLoadingIds: this.state.quotaLoadingIds.filter(
          (id) => id !== credentialId,
        ),
      });
    };
    try {
      const quota = readProviderQuota(
        await requestJson(
          providerCredentialQuotaPath(
            this.#configuration.credentialsPath,
            credentialId,
          ),
        ),
      );
      settle();
      this.#state.patch({
        quotas: { ...this.state.quotas, [credentialId]: quota },
      });
    } catch {
      settle();
    }
  }

  async consumeQuotaReset(
    credentialId: string,
  ): Promise<ProviderQuotaResetOutcome | undefined> {
    if (this.state.quotaPendingId !== undefined) {
      return undefined;
    }
    const clientRequestId =
      this.#quotaResetRequestIds.get(credentialId) ?? crypto.randomUUID();
    this.#quotaResetRequestIds.set(credentialId, clientRequestId);
    this.#state.patch({ error: undefined, quotaPendingId: credentialId });
    try {
      const result = readQuotaResetResult(
        await requestJson(
          providerCredentialQuotaResetPath(
            this.#configuration.credentialsPath,
            credentialId,
          ),
          jsonRequestInit({ clientRequestId }, "POST"),
        ),
      );
      this.#quotaResetRequestIds.delete(credentialId);
      this.#state.patch({
        quotaNotice: { credentialId, outcome: result.outcome },
        quotaPendingId: undefined,
        quotas: { ...this.state.quotas, [credentialId]: result.quota },
      });
      return result.outcome;
    } catch {
      this.#state.patch({
        error: `We could not consume that ${this.#configuration.name} quota reset.`,
        quotaPendingId: undefined,
      });
      return undefined;
    }
  }

  async setQuotaThreshold(
    credentialId: string,
    threshold: number,
  ): Promise<void> {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      this.#state.patch({
        error: "The quota threshold must be from 0 to 100%.",
      });
      return;
    }
    this.#state.patch({ quotaThresholdPendingId: credentialId });
    try {
      await request(
        providerCredentialQuotaThresholdPath(
          this.#configuration.credentialsPath,
          credentialId,
        ),
        jsonRequestInit({ autoResetThresholdPercent: threshold }, "PUT"),
      );
      await this.loadQuota(credentialId);
      this.#state.patch({ quotaThresholdPendingId: undefined });
    } catch {
      this.#state.patch({
        error: `We could not update that ${this.#configuration.name} quota threshold.`,
        quotaThresholdPendingId: undefined,
      });
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
    this.setWorkspace(GLOBAL_WORKSPACE_ID);
  }

  setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void> {
    return this.#mutate(
      connectionScopesPath(this.#configuration.credentialsPath, credentialId),
      jsonRequestInit({ workspaceIds }, "PUT"),
      {},
      {},
      () => `We could not update that ${this.#configuration.name} scope.`,
    );
  }

  setWorkspace(workspaceId: string): void {
    this.#resetForWorkspace(workspaceId);
  }

  #resetForWorkspace(workspaceId: string): void {
    this.#quotaResetRequestIds.clear();
    this.#state.revision.advance();
    this.#pendingSessionReassignment?.dialog.reset();
    this.#pendingSessionReassignment = undefined;
    this.#workspaceId = workspaceId;
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
    const reload = () => this.load();
    await this.#state.mutation(
      input,
      init,
      request,
      (error) => {
        const status = isHttpResponseError(error) ? error.status : 0;
        return { ...settled, error: errorMessage(status) };
      },
      { ...pending, error: undefined },
      settled,
      reload,
    );
  }

  #replace(state: ProviderViewState): void {
    this.#state.replace(state);
  }

  #saveError(status: number): string {
    if (status === 400) {
      return this.#configuration.id === "generic"
        ? "The generic provider rejected that API base URL or key. Check both and try again."
        : `${this.#configuration.name} rejected that API key. Check it and try again.`;
    }

    if (status === 409) {
      return `That ${this.#configuration.name} credential is already saved.`;
    }

    return status === 503
      ? this.#configurationError()
      : `We could not add that ${this.#configuration.name} API key. Please try again.`;
  }
}
