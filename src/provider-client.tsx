import { isRecord } from "./auth-model.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import {
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_PATH,
} from "./routes.ts";

type BrowserProviderId = "openai" | "openrouter";

export interface ProviderCredential {
  readonly accountId: string | null;
  readonly id: string;
  readonly label: string;
  readonly source: "api_key" | "oauth";
}

export interface ProviderViewState {
  readonly credentials: readonly ProviderCredential[] | undefined;
  readonly error: string | undefined;
  readonly removingId: string | undefined;
  readonly savePending: boolean;
}

export interface ProviderPanelConfiguration {
  readonly accountIdUnavailable: string;
  readonly connectLabel: string;
  readonly credentialsPath: string;
  readonly description: string;
  readonly emptyMessage: string;
  readonly id: BrowserProviderId;
  readonly keyPlaceholder: string;
  readonly name: string;
  readonly oauthPath: string;
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
  const source = value["source"];

  if (
    (accountId !== null && typeof accountId !== "string") ||
    typeof id !== "string" ||
    typeof label !== "string" ||
    (source !== "api_key" && source !== "oauth")
  ) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  return { accountId, id, label, source };
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

function renderCredential(
  configuration: ProviderPanelConfiguration,
  credential: ProviderCredential,
  removingId: string | undefined,
): JsxNode {
  const removing = removingId === credential.id;

  return (
    <li className="flex flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-semibold text-white">
            {credential.label}
          </p>
          <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs font-medium text-cyan-200">
            {credential.source === "oauth" ? "Connected account" : "API key"}
          </span>
        </div>
        <p className="mt-2 truncate text-sm text-slate-400">
          {credential.accountId ?? configuration.accountIdUnavailable}
        </p>
      </div>
      <button
        className="shrink-0 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        data-action="remove-provider-credential"
        data-credential-id={credential.id}
        disabled={removing}
        type="button"
      >
        {removing ? "Removing…" : "Remove"}
      </button>
    </li>
  );
}

function renderCredentialList(
  configuration: ProviderPanelConfiguration,
  state: ProviderViewState,
): JsxNode {
  if (state.credentials === undefined) {
    return state.error === undefined ? (
      <p className="mt-6 text-sm text-slate-400" role="status">
        {`Loading ${configuration.name} connections…`}
      </p>
    ) : null;
  }

  if (state.credentials.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-dashed border-white/15 p-6 text-sm leading-6 text-slate-400">
        {configuration.emptyMessage}
      </div>
    );
  }

  return (
    <ul className="mt-6 space-y-3">
      {state.credentials.map((credential) =>
        renderCredential(configuration, credential, state.removingId),
      )}
    </ul>
  );
}

export function renderProviderPanel(
  configuration: ProviderPanelConfiguration,
  state: ProviderViewState,
): JsxNode {
  const titleId = `${configuration.id}-title`;
  const inputId = `${configuration.id}-api-key`;

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      data-provider-panel={configuration.id}
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-cyan-300">Model access</p>
          <h2 className="mt-2 text-2xl font-semibold text-white" id={titleId}>
            {configuration.name}
          </h2>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            {configuration.description}
          </p>
        </div>
        <a
          className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-cyan-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
          href={configuration.oauthPath}
        >
          {configuration.connectLabel}
        </a>
      </div>

      <form
        className="mt-7 grid gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
        data-action="add-provider-key"
      >
        <div>
          <label
            className="text-sm font-medium text-slate-200"
            htmlFor={inputId}
          >
            {`${configuration.name} API key`}
          </label>
          <input
            autocomplete="off"
            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
            disabled={state.savePending}
            id={inputId}
            name="apiKey"
            placeholder={configuration.keyPlaceholder}
            required
            type="password"
          />
        </div>
        <button
          className="self-end rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-5 py-3 font-semibold text-emerald-200 transition hover:bg-emerald-300/20 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
          disabled={state.savePending}
          type="submit"
        >
          {state.savePending ? "Adding…" : "Add API key"}
        </button>
      </form>

      {state.error === undefined ? null : (
        <div
          className="mt-5 flex flex-col gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p>{state.error}</p>
          <button
            className="shrink-0 font-semibold underline underline-offset-4"
            data-action="retry-provider"
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {renderCredentialList(configuration, state)}
      <p className="mt-5 text-xs leading-5 text-slate-500">
        {configuration.removalHelp}
      </p>
    </section>
  );
}
