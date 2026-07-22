import { type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import {
  BRAVE_SEARCH_KEYS_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_PATH,
} from "../shared/routes.ts";
import { renderRemovalButton, renderRetryError } from "./client-controls.tsx";
import { renderDefaultableActions } from "./defaultable-actions.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";

type BrowserProviderId = "brave-search" | "openai" | "openrouter";

export interface ProviderCredential {
  readonly accountId: string | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly label: string;
  readonly source: "api_key" | "oauth";
}

interface ProviderViewStateBase {
  readonly credentials: readonly ProviderCredential[] | undefined;
  readonly error: string | undefined;
  readonly removingId: string | undefined;
  readonly savePending: boolean;
  readonly settingDefaultId: string | undefined;
}

export function createProviderViewState(
  credentials: readonly ProviderCredential[] | undefined,
): ProviderViewStateBase {
  return {
    credentials,
    error: undefined,
    removingId: undefined,
    savePending: false,
    settingDefaultId: undefined,
  };
}

export type ProviderViewState = ProviderViewStateBase;

export interface ProviderPanelConfiguration {
  readonly accountIdUnavailable: string;
  readonly connectLabel?: string;
  readonly credentialsPath: string;
  readonly description: string;
  readonly emptyMessage: string;
  readonly id: BrowserProviderId;
  readonly keyPlaceholder: string;
  readonly keyRequiresLabel?: boolean;
  readonly name: string;
  readonly oauthPath?: string;
  readonly removalHelp: string;
}

export const OPENAI_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "OpenAI account ID unavailable",
  connectLabel: "Connect OpenAI account",
  credentialsPath: OPENAI_CREDENTIALS_PATH,
  description:
    "Connect multiple OpenAI accounts with OAuth or save multiple API keys. Credentials stay encrypted in the local database.",
  emptyMessage:
    "No OpenAI accounts or keys yet. Connect an account or add as many keys as you need.",
  id: "openai",
  keyPlaceholder: "sk-…",
  name: "OpenAI",
  oauthPath: OPENAI_OAUTH_PATH,
  removalHelp:
    "Removing a credential only removes the local copy. Revoke connected access in OpenAI if you no longer want it to exist there.",
};

export const OPENROUTER_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "OpenRouter account ID unavailable",
  connectLabel: "Connect OpenRouter account",
  credentialsPath: OPENROUTER_CREDENTIALS_PATH,
  description:
    "Connect multiple OpenRouter accounts with OAuth or save multiple API keys. Credentials stay encrypted in the local database.",
  emptyMessage:
    "No OpenRouter accounts or keys yet. Connect an account or add as many keys as you need.",
  id: "openrouter",
  keyPlaceholder: "sk-or-v1-…",
  name: "OpenRouter",
  oauthPath: OPENROUTER_OAUTH_PATH,
  removalHelp:
    "Removing a credential only removes the local copy. Revoke OAuth-created keys from OpenRouter if you no longer want them to exist there.",
};

export const BRAVE_SEARCH_PANEL: ProviderPanelConfiguration = {
  accountIdUnavailable: "Available to the Brave Search agent skill",
  credentialsPath: BRAVE_SEARCH_KEYS_PATH,
  description:
    "Give agents server-side web search without exposing keys to the browser, model provider, or runner. Keys stay encrypted in the local database.",
  emptyMessage:
    "No Brave Search keys yet. Add as many keys as you need; the skill can try another saved key when one is unavailable.",
  id: "brave-search",
  keyPlaceholder: "BSA…",
  keyRequiresLabel: true,
  name: "Brave Search",
  removalHelp:
    "Removing a key clears the encrypted local copy. Revoke it in Brave if it should no longer work outside Q Mush.",
};

function readCredential(
  value: unknown,
  providerName: string,
): ProviderCredential {
  if (!isRecord(value)) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  const accountId = value["accountId"];
  const id = value["id"];
  const label = value["label"];
  const isDefault = value["isDefault"];
  const source = value["source"];

  if (
    (accountId !== null && typeof accountId !== "string") ||
    typeof id !== "string" ||
    typeof isDefault !== "boolean" ||
    typeof label !== "string" ||
    (source !== "api_key" && source !== "oauth")
  ) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  return { accountId, id, isDefault, label, source };
}

export function readProviderCredentials(
  value: unknown,
  providerName: string,
): readonly ProviderCredential[] {
  if (!isRecord(value) || !Array.isArray(value["credentials"])) {
    throw new Error(
      `The server returned an invalid ${providerName} credential list`,
    );
  }

  return value["credentials"].map((credential) =>
    readCredential(credential, providerName),
  );
}

function renderCredentialActions(
  configuration: ProviderPanelConfiguration,
  credential: ProviderCredential,
  removing: boolean,
  settingDefault: boolean,
): JSX.Element {
  return configuration.id === "brave-search"
    ? renderRemovalButton({
        action: "remove-provider-credential",
        dataAttribute: "data-credential-id",
        id: credential.id,
        pending: removing,
      })
    : renderDefaultableActions({
        defaultAction: "set-default-provider-credential",
        id: credential.id,
        idAttribute: "data-credential-id",
        isDefault: credential.isDefault,
        removeAction: "remove-provider-credential",
        removing,
        settingDefault,
      });
}

function renderCredential(
  configuration: ProviderPanelConfiguration,
  state: {
    readonly credential: ProviderCredential;
    readonly removingId: string | undefined;
    readonly settingDefaultId: string | undefined;
  },
): JSX.Element {
  const { credential, removingId, settingDefaultId } = state;

  return (
    <li
      class="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-5 sm:flex-row sm:items-center sm:justify-between"
      {...renderDebugBoundary(
        `provider-credential:${configuration.id}:${credential.id}`,
        `${configuration.name} credential: ${credential.label}`,
      )}
    >
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="truncate font-semibold text-white">{credential.label}</p>
          <span class="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs font-medium text-cyan-200">
            {credential.source === "oauth" ? "Connected account" : "API key"}
          </span>
        </div>
        <p class="mt-2 truncate text-sm text-slate-400">
          {credential.accountId ?? configuration.accountIdUnavailable}
        </p>
      </div>
      {renderCredentialActions(
        configuration,
        credential,
        removingId === credential.id,
        settingDefaultId === credential.id,
      )}
    </li>
  );
}

function renderCredentialList(
  configuration: ProviderPanelConfiguration,
  state: ProviderViewState,
): JSX.Element {
  if (state.credentials === undefined) {
    return state.error === undefined ? (
      <p class="mt-6 text-sm text-slate-400" role="status">
        {`Loading ${configuration.name} ${configuration.id === "brave-search" ? "keys" : "connections"}…`}
      </p>
    ) : null;
  }

  if (state.credentials.length === 0) {
    return (
      <div class="mt-6 rounded-2xl border border-dashed border-white/15 p-6 text-sm leading-6 text-slate-400">
        {configuration.emptyMessage}
      </div>
    );
  }

  return (
    <ul class="mt-6 space-y-3">
      {state.credentials.map((credential) =>
        renderCredential(configuration, {
          credential,
          removingId: state.removingId,
          settingDefaultId: state.settingDefaultId,
        }),
      )}
    </ul>
  );
}

export function renderProviderPanel(
  configuration: ProviderPanelConfiguration,
  state: ProviderViewState,
): JSX.Element {
  const titleId = `${configuration.id}-title`;
  const inputId = `${configuration.id}-api-key`;

  return (
    <section
      aria-labelledby={titleId}
      class="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      data-provider-panel={configuration.id}
      {...renderDebugBoundary(
        `provider-panel:${configuration.id}`,
        `${configuration.name} panel`,
      )}
    >
      <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p class="text-sm font-medium text-cyan-300">
            {configuration.id === "brave-search"
              ? "Agent skill"
              : "Model access"}
          </p>
          <h2 class="mt-2 text-2xl font-semibold text-white" id={titleId}>
            {configuration.name}
          </h2>
          <p class="mt-3 max-w-2xl leading-7 text-slate-400">
            {configuration.description}
          </p>
        </div>
        {configuration.oauthPath === undefined ||
        configuration.connectLabel === undefined ? null : (
          <a
            class="inline-flex shrink-0 items-center justify-center rounded-2xl bg-cyan-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            href={configuration.oauthPath}
          >
            {configuration.connectLabel}
          </a>
        )}
      </div>

      <form
        class={`mt-7 grid gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 ${configuration.keyRequiresLabel === true ? "sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"}`}
        data-action="add-provider-key"
        {...renderDebugBoundary(
          `provider-form:${configuration.id}`,
          `${configuration.name} key form`,
        )}
      >
        {configuration.keyRequiresLabel === true ? (
          <div>
            <label
              class="text-sm font-medium text-slate-200"
              for={`${configuration.id}-key-label`}
            >
              Label
            </label>
            <input
              autocomplete="off"
              class="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
              disabled={state.savePending}
              id={`${configuration.id}-key-label`}
              maxLength="100"
              name="label"
              placeholder="Primary"
              required
              type="text"
            />
          </div>
        ) : null}
        <div>
          <label class="text-sm font-medium text-slate-200" for={inputId}>
            {`${configuration.name} API key`}
          </label>
          <input
            autocomplete="off"
            class="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
            disabled={state.savePending}
            id={inputId}
            name="apiKey"
            placeholder={configuration.keyPlaceholder}
            required
            type="password"
          />
        </div>
        <button
          class="self-end rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-5 py-3 font-semibold text-emerald-200 transition hover:bg-emerald-300/20 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          disabled={state.savePending}
          type="submit"
        >
          {state.savePending ? "Adding…" : "Add API key"}
        </button>
      </form>

      {renderRetryError(state.error, "retry-provider")}

      {renderCredentialList(configuration, state)}
      <p class="mt-5 text-xs leading-5 text-slate-500">
        {configuration.removalHelp}
      </p>
    </section>
  );
}
