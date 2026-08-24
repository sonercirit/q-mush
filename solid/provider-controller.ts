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
import {
  createControllerState,
  jsonRequestInit,
} from "./controller-mutation.ts";
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

export interface ProviderController {
  readonly state: ProviderViewState;
  readonly view: Accessor<ProviderViewState>;
  add(...input: ProviderCredentialAddInput): Promise<void>;
  confirmSessionReassignment(
    dialog: SessionReassignmentDialogController,
  ): Promise<void>;
  consumeQuotaReset(
    credentialId: string,
  ): Promise<ProviderQuotaResetOutcome | undefined>;
  load(): Promise<void>;
  loadQuota(credentialId: string): Promise<void>;
  remove(credentialId: string): Promise<void>;
  reset(): void;
  setDefault(credentialId: string): Promise<void>;
  setQuotaThreshold(
    credentialId: string,
    threshold: number | undefined,
  ): Promise<void>;
  setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void>;
  setWorkspace(workspaceId: string): void;
}

export function createProviderController(
  configuration: ProviderPanelConfiguration,
  view = createReactiveState(initialProviderState()),
): ProviderController {
  const quotaResetRequestIds = new Map<string, string>();
  const stateController = createControllerState(view);
  let pendingSessionReassignment:
    | {
        readonly dialog: SessionReassignmentDialogController;
        readonly revision: number;
      }
    | undefined;
  let workspaceId = GLOBAL_WORKSPACE_ID;

  const state = (): ProviderViewState => stateController.value;

  const viewAccessor = stateController.accessor;

  async function add(
    ...[apiKey, label, baseUrl, apiFormat]: ProviderCredentialAddInput
  ): Promise<void> {
    await mutate(
      configuration.credentialsPath,
      jsonRequestInit(
        {
          ...(configuration.apiFormatSelectable === true &&
          apiFormat !== undefined
            ? { apiFormat }
            : {}),
          apiKey,
          ...(configuration.baseUrlPlaceholder === undefined
            ? {}
            : { baseUrl }),
          ...(configuration.keyRequiresLabel === true ? { label } : {}),
          workspaceIds: [workspaceId],
        },
        "POST",
      ),
      { savePending: true },
      { savePending: false },
      (status) => saveError(status),
    );
  }

  async function confirmSessionReassignment(
    dialog: SessionReassignmentDialogController,
  ): Promise<void> {
    const state = dialog.state;
    if (state === undefined || state.pending) {
      return;
    }

    const revision = stateController.revision.value();
    const pending = { dialog, revision };
    pendingSessionReassignment = pending;
    dialog.pending();
    try {
      const result = readSessionCredentialReassignmentResult(
        await requestJson(
          `${providerCredentialSessionReassignmentPath(
            configuration.credentialsPath,
            state.credential.id,
          )}?workspaceId=${encodeURIComponent(workspaceId)}`,
          {
            body: JSON.stringify(
              workspaceId === GLOBAL_WORKSPACE_ID
                ? {}
                : { workspaceId: workspaceId },
            ),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      const count = result.migratedSessionCount;
      dialog.succeeded();
      if (stateController.revision.isCurrent(revision)) {
        stateController.patch({
          sessionReassignmentNotice:
            count === 0
              ? "No sessions needed switching; they already use this account."
              : `${String(count)} ${count === 1 ? "session" : "sessions"} switched to this account.`,
        });
      }
    } catch {
      if (stateController.revision.isCurrent(revision)) {
        dialog.failed(
          `We could not switch your ${configuration.name} sessions. Please try again.`,
        );
      } else {
        dialog.succeeded();
      }
    } finally {
      if (
        stateController.revision.isCurrent(revision) &&
        pendingSessionReassignment === pending
      ) {
        pendingSessionReassignment = undefined;
      }
    }
  }

  async function load(): Promise<void> {
    await stateController.load({
      failure: (error) => ({
        error: isHttpResponseError(error)
          ? loadError(error.status)
          : loadError(0),
      }),
      pending: { credentials: undefined, error: undefined },
      request: () =>
        requestJson(
          `${configuration.credentialsPath}?workspaceId=${encodeURIComponent(workspaceId)}`,
        ),
      success: (value) => {
        const credentials = readProviderCredentials(value, configuration.name);
        return {
          credentials,
          error: undefined,
          quotaLoadingIds:
            configuration.id === "brave-search" ||
            configuration.quotaSupported === false
              ? []
              : credentials.map(({ id }) => id),
        };
      },
    });
    if (
      configuration.id !== "brave-search" &&
      configuration.quotaSupported !== false
    ) {
      await Promise.all(
        state().quotaLoadingIds.map((credentialId) => loadQuota(credentialId)),
      );
    }
  }

  async function loadQuota(credentialId: string): Promise<void> {
    const loading = new Set(state().quotaLoadingIds);
    loading.add(credentialId);
    stateController.patch({ quotaLoadingIds: [...loading] });
    const settle = (): void => {
      stateController.patch({
        quotaLoadingIds: state().quotaLoadingIds.filter(
          (id) => id !== credentialId,
        ),
      });
    };
    try {
      const quota = readProviderQuota(
        await requestJson(
          providerCredentialQuotaPath(
            configuration.credentialsPath,
            credentialId,
          ),
        ),
      );
      settle();
      stateController.patch({
        quotas: { ...state().quotas, [credentialId]: quota },
      });
    } catch {
      settle();
    }
  }

  async function consumeQuotaReset(
    credentialId: string,
  ): Promise<ProviderQuotaResetOutcome | undefined> {
    if (state().quotaPendingId !== undefined) {
      return undefined;
    }
    const clientRequestId =
      quotaResetRequestIds.get(credentialId) ?? crypto.randomUUID();
    quotaResetRequestIds.set(credentialId, clientRequestId);
    stateController.patch({ error: undefined, quotaPendingId: credentialId });
    try {
      const result = readQuotaResetResult(
        await requestJson(
          providerCredentialQuotaResetPath(
            configuration.credentialsPath,
            credentialId,
          ),
          jsonRequestInit({ clientRequestId }, "POST"),
        ),
      );
      quotaResetRequestIds.delete(credentialId);
      stateController.patch({
        quotaNotice: { credentialId, outcome: result.outcome },
        quotaPendingId: undefined,
        quotas: { ...state().quotas, [credentialId]: result.quota },
      });
      return result.outcome;
    } catch {
      stateController.patch({
        error: `We could not consume that ${configuration.name} quota reset.`,
        quotaPendingId: undefined,
      });
      return undefined;
    }
  }

  async function setQuotaThreshold(
    credentialId: string,
    threshold: number,
  ): Promise<void> {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
      stateController.patch({
        error: "The quota threshold must be from 0 to 100%.",
      });
      return;
    }
    stateController.patch({ quotaThresholdPendingId: credentialId });
    try {
      await request(
        providerCredentialQuotaThresholdPath(
          configuration.credentialsPath,
          credentialId,
        ),
        jsonRequestInit({ autoResetThresholdPercent: threshold }, "PUT"),
      );
      await loadQuota(credentialId);
      stateController.patch({ quotaThresholdPendingId: undefined });
    } catch {
      stateController.patch({
        error: `We could not update that ${configuration.name} quota threshold.`,
        quotaThresholdPendingId: undefined,
      });
    }
  }

  function remove(credentialId: string): Promise<void> {
    return mutate(
      `${configuration.credentialsPath}/${encodeURIComponent(credentialId)}`,
      { method: "DELETE" },
      { removingId: credentialId },
      { removingId: undefined },
      () => `We could not remove that ${configuration.name} credential.`,
    );
  }

  function reset(): void {
    setWorkspace(GLOBAL_WORKSPACE_ID);
  }

  function setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void> {
    return mutate(
      connectionScopesPath(configuration.credentialsPath, credentialId),
      jsonRequestInit({ workspaceIds }, "PUT"),
      {},
      {},
      () => `We could not update that ${configuration.name} scope.`,
    );
  }

  function setWorkspace(nextWorkspaceId: string): void {
    resetForWorkspace(nextWorkspaceId);
  }

  function resetForWorkspace(nextWorkspaceId: string): void {
    quotaResetRequestIds.clear();
    stateController.revision.advance();
    pendingSessionReassignment?.dialog.reset();
    pendingSessionReassignment = undefined;
    workspaceId = nextWorkspaceId;
    replace(initialProviderState());
  }

  function setDefault(credentialId: string): Promise<void> {
    return mutate(
      providerCredentialDefaultPath(
        configuration.credentialsPath,
        credentialId,
      ),
      { method: "POST" },
      { settingDefaultId: credentialId },
      { settingDefaultId: undefined },
      () =>
        `We could not make that ${configuration.name} credential the default.`,
    );
  }

  function configurationError(): string {
    const variable =
      configuration.id === "brave-search"
        ? "BRAVE_SEARCH_CREDENTIAL_KEY"
        : `${configuration.id.toUpperCase()}_CREDENTIAL_KEY`;
    return `${configuration.name} storage is not configured. Set ${variable} on the local server and restart it.`;
  }

  function loadError(status: number): string {
    return status === 503
      ? configurationError()
      : `We could not load your ${configuration.name} credentials. Please try again.`;
  }

  async function mutate(
    input: RequestInfo | URL,
    init: RequestInit,
    pending: StatePatch,
    settled: StatePatch,
    errorMessage: ErrorMessage,
  ): Promise<void> {
    const reload = () => load();
    await stateController.mutation(
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

  function replace(state: ProviderViewState): void {
    stateController.replace(state);
  }

  function saveError(status: number): string {
    if (status === 400) {
      return configuration.id === "generic"
        ? "The generic provider rejected that API base URL or key. Check both and try again."
        : `${configuration.name} rejected that API key. Check it and try again.`;
    }

    if (status === 409) {
      return `That ${configuration.name} credential is already saved.`;
    }

    return status === 503
      ? configurationError()
      : `We could not add that ${configuration.name} API key. Please try again.`;
  }

  return {
    add,
    confirmSessionReassignment,
    consumeQuotaReset,
    load,
    loadQuota,
    remove,
    reset,
    get state() {
      return state();
    },
    setDefault,
    setQuotaThreshold,
    setScopes,
    setWorkspace,
    view: viewAccessor,
  };
}
