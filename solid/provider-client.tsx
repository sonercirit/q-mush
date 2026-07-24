import { createSignal, Show, type Accessor, type JSX } from "solid-js";
import { isRecord } from "../shared/auth-model.ts";
import {
  BRAVE_SEARCH_KEYS_PATH,
  OPENAI_CREDENTIALS_PATH,
  OPENAI_OAUTH_PATH,
  OPENROUTER_CREDENTIALS_PATH,
  OPENROUTER_OAUTH_PATH,
} from "../shared/routes.ts";
import type { WorkspaceList } from "../shared/workspace-model.ts";
import { RemovalButton } from "./client-controls.tsx";
import { Collection } from "./collection.tsx";
import { ConnectionScopeEditor } from "./connection-scope-client.tsx";
import { DefaultableActions } from "./defaultable-actions.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";

type BrowserProviderId = "brave-search" | "openai" | "openrouter";

export interface ProviderCredential {
  readonly accountId: string | null;
  readonly id: string;
  readonly isDefault: boolean;
  readonly isGlobal?: boolean;
  readonly label: string;
  readonly source: "api_key" | "oauth";
  readonly workspaceIds?: readonly string[];
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
  const isGlobal = value["isGlobal"];
  const source = value["source"];
  const workspaceIds = value["workspaceIds"];

  if (
    (accountId !== null && typeof accountId !== "string") ||
    typeof id !== "string" ||
    typeof isDefault !== "boolean" ||
    typeof isGlobal !== "boolean" ||
    typeof label !== "string" ||
    (source !== "api_key" && source !== "oauth") ||
    !Array.isArray(workspaceIds) ||
    !workspaceIds.every((id) => typeof id === "string")
  ) {
    throw new Error(
      `The server returned an invalid ${providerName} credential`,
    );
  }

  return {
    accountId,
    id,
    isDefault,
    isGlobal,
    label,
    source,
    workspaceIds,
  };
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

interface ProviderPanelProps {
  readonly configuration: ProviderPanelConfiguration;
  readonly controller: ProviderPanelController;
  readonly selectedWorkspaceId?: string;
  readonly workspaces?: Accessor<WorkspaceList | undefined>;
}

interface CredentialItemProps {
  readonly configuration: ProviderPanelConfiguration;
  readonly controller: ProviderPanelController;
  readonly credential: ProviderCredential;
  readonly state: ProviderViewState;
  readonly workspaces?: Accessor<WorkspaceList | undefined>;
}

function CredentialActions(props: CredentialItemProps): JSX.Element {
  const remove = (): void => {
    void props.controller.remove(props.credential.id);
  };
  const removing = (): boolean =>
    props.state.removingId === props.credential.id;
  const settingDefault = (): boolean =>
    props.state.settingDefaultId === props.credential.id;

  return (
    <Show
      fallback={
        <DefaultableActions
          data={{ "data-credential-id": props.credential.id }}
          isDefault={props.credential.isDefault}
          onRemove={remove}
          onSetDefault={() => {
            void props.controller.setDefault(props.credential.id);
          }}
          removing={removing()}
          settingDefault={settingDefault()}
        />
      }
      when={props.configuration.id === "brave-search"}
    >
      <RemovalButton onClick={remove} pending={removing()} />
    </Show>
  );
}

function ProviderCredentialItem(props: CredentialItemProps): JSX.Element {
  return (
    <li
      class="flex min-w-0 flex-col gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 sm:p-5 md:flex-row md:items-center md:justify-between"
      {...renderDebugBoundary(
        `provider-credential:${props.configuration.id}:${props.credential.id}`,
        `${props.configuration.name} credential: ${props.credential.label}`,
      )}
    >
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="path-wrap font-semibold text-white">
            {props.credential.label}
          </p>
          <span class="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-2.5 py-1 text-xs font-medium text-cyan-200">
            {props.credential.source === "oauth"
              ? "Connected account"
              : "API key"}
          </span>
        </div>
        <p class="path-wrap mt-2 text-sm text-slate-400">
          {props.credential.accountId ??
            props.configuration.accountIdUnavailable}
        </p>
      </div>
      <div class="min-w-0">
        <p class="text-xs text-slate-500">
          {props.credential.isGlobal === true
            ? "Scope: Global"
            : `Scope: ${String(props.credential.workspaceIds?.length ?? 0)} workspace(s)`}
        </p>
      </div>
      <Show when={props.workspaces}>
        {(workspaces) => (
          <ConnectionScopeEditor
            connection={props.credential}
            controller={props.controller}
            workspaces={workspaces()}
          />
        )}
      </Show>
      <CredentialActions {...props} />
    </li>
  );
}

function ProviderCredentialList({
  configuration,
  controller,
  workspaces,
}: ProviderPanelProps): JSX.Element {
  const state = controller.view;
  const retry = {
    get error(): string | undefined {
      return state().error;
    },
    onRetry: (): void => void controller.load(),
  };
  return (
    <Collection
      empty={
        <div class="mt-6 rounded-2xl border border-dashed border-white/15 p-4 text-sm leading-6 text-slate-400 sm:p-6">
          {configuration.emptyMessage}
        </div>
      }
      items={state().credentials}
      listClass="mt-6 space-y-3"
      loading={
        <p class="mt-6 text-sm text-slate-400" role="status">
          {`Loading ${configuration.name} ${configuration.id === "brave-search" ? "keys" : "connections"}…`}
        </p>
      }
      retry={retry}
    >
      {(credential) => {
        const item: CredentialItemProps = {
          configuration,
          controller,
          credential,
          state: state(),
          ...(workspaces === undefined ? {} : { workspaces }),
        };
        return <ProviderCredentialItem {...item} />;
      }}
    </Collection>
  );
}

function credentialInputAttributes(disabled: boolean) {
  return {
    autocomplete: "off",
    class:
      "mt-2 min-h-12 w-full min-w-0 rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none",
    disabled,
  } as const;
}

export function ProviderPanel(props: ProviderPanelProps): JSX.Element {
  const state = props.controller.view;
  const titleId = (): string => `${props.configuration.id}-title`;
  const inputId = (): string => `${props.configuration.id}-api-key`;
  const [form, setForm] = createSignal<HTMLFormElement>();

  return (
    <section
      aria-labelledby={titleId()}
      class="min-w-0 rounded-3xl border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-6 lg:p-8"
      data-provider-panel={props.configuration.id}
      {...renderDebugBoundary(
        `provider-panel:${props.configuration.id}`,
        `${props.configuration.name} panel`,
      )}
    >
      <div class="flex min-w-0 flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-cyan-300">
            {props.configuration.id === "brave-search"
              ? "Agent skill"
              : "Model access"}
          </p>
          <h2 class="mt-2 text-2xl font-semibold text-white" id={titleId()}>
            {props.configuration.name}
          </h2>
          <p class="mt-3 max-w-2xl leading-7 text-slate-400">
            {props.configuration.description}
          </p>
        </div>
        <Show
          when={
            props.configuration.oauthPath === undefined ||
            props.configuration.connectLabel === undefined
              ? undefined
              : {
                  label: props.configuration.connectLabel,
                  path: props.configuration.oauthPath,
                }
          }
        >
          {(oauth) => (
            <a
              class="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-2xl bg-cyan-300 px-5 py-3 text-center font-semibold text-slate-950 transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300 sm:w-auto"
              href={`${oauth().path}?workspaceId=${encodeURIComponent(props.selectedWorkspaceId ?? "global")}`}
            >
              {oauth().label}
            </a>
          )}
        </Show>
      </div>

      <form
        class={`mt-7 grid min-w-0 gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 ${props.configuration.keyRequiresLabel === true ? "md:grid-cols-2 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto]" : "md:grid-cols-[minmax(0,1fr)_auto]"}`}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const apiKey = data.get("apiKey");
          const label = data.get("label");
          if (typeof apiKey === "string") {
            void props.controller
              .add(apiKey, typeof label === "string" ? label : undefined)
              .then(() => {
                form()?.reset();
              });
          }
        }}
        ref={setForm}
        {...renderDebugBoundary(
          `provider-form:${props.configuration.id}`,
          `${props.configuration.name} key form`,
        )}
      >
        <Show when={props.configuration.keyRequiresLabel === true}>
          <div>
            <label
              class="text-sm font-medium text-slate-200"
              for={`${props.configuration.id}-key-label`}
            >
              Label
            </label>
            <input
              {...credentialInputAttributes(state().savePending)}
              id={`${props.configuration.id}-key-label`}
              maxLength="100"
              name="label"
              placeholder="Primary"
              required
              type="text"
            />
          </div>
        </Show>
        <div>
          <label class="text-sm font-medium text-slate-200" for={inputId()}>
            {`${props.configuration.name} API key`}
          </label>
          <input
            {...credentialInputAttributes(state().savePending)}
            id={inputId()}
            name="apiKey"
            placeholder={props.configuration.keyPlaceholder}
            required
            type="password"
          />
        </div>
        <button
          class="min-h-11 self-end rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-5 py-3 font-semibold text-emerald-200 transition hover:bg-emerald-300/20 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 md:justify-self-start xl:justify-self-auto"
          disabled={state().savePending}
          type="submit"
        >
          {state().savePending ? "Adding…" : "Add API key"}
        </button>
      </form>

      <ProviderCredentialList
        configuration={props.configuration}
        controller={props.controller}
        {...(props.workspaces === undefined
          ? {}
          : { workspaces: props.workspaces })}
      />
      <p class="mt-5 text-xs leading-5 text-slate-500">
        {props.configuration.removalHelp}
      </p>
    </section>
  );
}

interface ProviderPanelController {
  readonly view: Accessor<ProviderViewState>;
  add(apiKey: string, label?: string): Promise<void>;
  load(): Promise<void>;
  remove(credentialId: string): Promise<void>;
  setDefault(credentialId: string): Promise<void>;
  setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void>;
}
