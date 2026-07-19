import { isRecord } from "./auth-model.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import { OPENROUTER_OAUTH_PATH } from "./routes.ts";

export interface OpenRouterCredential {
  readonly accountId: string | null;
  readonly id: string;
  readonly label: string;
  readonly source: "api_key" | "oauth";
}

export interface OpenRouterViewState {
  readonly credentials: readonly OpenRouterCredential[] | undefined;
  readonly error: string | undefined;
  readonly removingId: string | undefined;
  readonly savePending: boolean;
}

function readCredential(value: unknown): OpenRouterCredential {
  if (!isRecord(value)) {
    throw new Error("The server returned an invalid OpenRouter credential");
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
    throw new Error("The server returned an invalid OpenRouter credential");
  }

  return { accountId, id, label, source };
}

export function readOpenRouterCredentials(
  value: unknown,
): readonly OpenRouterCredential[] {
  if (!isRecord(value) || !Array.isArray(value["credentials"])) {
    throw new Error(
      "The server returned an invalid OpenRouter credential list",
    );
  }

  return value["credentials"].map((credential) => readCredential(credential));
}

function renderCredential(
  credential: OpenRouterCredential,
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
          {credential.accountId ?? "OpenRouter account ID unavailable"}
        </p>
      </div>
      <button
        className="shrink-0 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300"
        data-action="remove-openrouter-credential"
        data-credential-id={credential.id}
        disabled={removing}
        type="button"
      >
        {removing ? "Removing…" : "Remove"}
      </button>
    </li>
  );
}

function renderCredentialList(state: OpenRouterViewState): JsxNode {
  if (state.credentials === undefined) {
    return state.error === undefined ? (
      <p className="mt-6 text-sm text-slate-400" role="status">
        Loading OpenRouter connections…
      </p>
    ) : null;
  }

  if (state.credentials.length === 0) {
    return (
      <div className="mt-6 rounded-2xl border border-dashed border-white/15 p-6 text-sm leading-6 text-slate-400">
        No OpenRouter accounts or keys yet. Connect an account or add as many
        keys as you need.
      </div>
    );
  }

  return (
    <ul className="mt-6 space-y-3">
      {state.credentials.map((credential) =>
        renderCredential(credential, state.removingId),
      )}
    </ul>
  );
}

export function renderOpenRouterPanel(state: OpenRouterViewState): JsxNode {
  return (
    <section
      aria-labelledby="openrouter-title"
      className="rounded-3xl border border-white/10 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-cyan-300">Model access</p>
          <h2
            className="mt-2 text-2xl font-semibold text-white"
            id="openrouter-title"
          >
            OpenRouter
          </h2>
          <p className="mt-3 max-w-2xl leading-7 text-slate-400">
            Connect multiple OpenRouter accounts with OAuth or save multiple API
            keys. Credentials stay encrypted in the local database.
          </p>
        </div>
        <a
          className="inline-flex shrink-0 items-center justify-center rounded-2xl bg-cyan-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
          href={OPENROUTER_OAUTH_PATH}
        >
          Connect OpenRouter account
        </a>
      </div>

      <form
        className="mt-7 grid gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
        data-action="add-openrouter-key"
      >
        <div>
          <label
            className="text-sm font-medium text-slate-200"
            htmlFor="openrouter-api-key"
          >
            OpenRouter API key
          </label>
          <input
            autocomplete="off"
            className="mt-2 w-full rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
            disabled={state.savePending}
            id="openrouter-api-key"
            name="apiKey"
            placeholder="sk-or-v1-…"
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
            data-action="retry-openrouter"
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {renderCredentialList(state)}
      <p className="mt-5 text-xs leading-5 text-slate-500">
        Removing a credential only removes the local copy. Revoke OAuth-created
        keys from OpenRouter if you no longer want them to exist there.
      </p>
    </section>
  );
}
