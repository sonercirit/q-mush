import { createSignal, For, Show, type Accessor, type JSX } from "solid-js";
import type { ProviderQuotaResetOutcome } from "../shared/provider-quota.ts";
import type { WorkspaceList } from "../shared/workspace-model.ts";
import { RemovalButton } from "./client-controls.tsx";
import { Collection } from "./collection.tsx";
import { optionalWorkspaces } from "./connection-client.ts";
import { controllerView } from "./controller-view.ts";
import { DefaultableActions } from "./defaultable-actions.tsx";
import { FormField } from "./form-field.tsx";
import type {
  ProviderCredential,
  ProviderCredentialAddInput,
  ProviderViewState,
} from "./provider-credential-model.ts";
import type { ProviderPanelConfiguration } from "./provider-panel-configuration.ts";
import { ProviderQuota } from "./provider-quota-client.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";
import { ScopedConnectionEditor } from "./scoped-connection-editor.tsx";
import { SessionReassignmentDialogController } from "./session-reassignment-dialog-controller.ts";
import { SessionReassignmentDialog } from "./session-reassignment-dialog.tsx";

export {
  BRAVE_SEARCH_PANEL,
  GENERIC_PANEL,
  OPENAI_PANEL,
  OPENROUTER_PANEL,
} from "./provider-panel-configuration.ts";

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
  readonly onOpenSessionReassignment: (
    credential: ProviderCredential,
    trigger: HTMLElement,
  ) => void;
  readonly selectedWorkspaceId?: string;
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
        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            class="min-h-11 rounded-xl border border-cyan-300/20 px-4 py-2 text-sm font-semibold text-cyan-200 transition hover:border-cyan-300/40 hover:bg-cyan-300/10 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-300"
            data-credential-id={props.credential.id}
            onClick={(event) => {
              props.onOpenSessionReassignment(
                props.credential,
                event.currentTarget,
              );
            }}
            type="button"
          >
            Switch sessions to this account
          </button>
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
        </div>
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
              : props.configuration.id === "generic"
                ? props.credential.apiFormat === "anthropic"
                  ? "Anthropic API endpoint"
                  : "OpenAI API endpoint"
                : "API key"}
          </span>
          <Show when={props.credential.requiresReauthentication}>
            <span class="rounded-full border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100">
              Re-login required
            </span>
          </Show>
        </div>
        <Show when={props.credential.requiresReauthentication}>
          <p class="mt-2 text-sm font-medium text-amber-100" role="alert">
            {`This ${props.configuration.name} login has expired. `}
            <Show
              fallback="Connect the account again before using it in a session."
              when={props.configuration.oauthPath}
            >
              {(oauthPath) => (
                <a
                  class="underline decoration-amber-200/60 underline-offset-2 hover:text-white"
                  href={`${oauthPath()}?workspaceId=${encodeURIComponent(props.selectedWorkspaceId ?? "global")}&credentialId=${encodeURIComponent(props.credential.id)}`}
                >
                  Reconnect this account
                </a>
              )}
            </Show>
          </p>
        </Show>
        <p class="path-wrap mt-2 text-sm text-slate-400">
          {props.credential.baseUrl ??
            props.credential.accountId ??
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
      <ScopedConnectionEditor
        connection={props.credential}
        controller={props.controller}
        workspaces={props.workspaces}
      />
      <Show
        when={
          props.configuration.quotaSupported !== false &&
          props.configuration.id !== "brave-search"
        }
      >
        <ProviderQuota
          controller={props.controller}
          credential={props.credential}
        />
      </Show>
      <CredentialActions {...props} />
    </li>
  );
}

function ProviderCredentialList(
  props: ProviderPanelProps & {
    readonly onOpenSessionReassignment: CredentialItemProps["onOpenSessionReassignment"];
  },
): JSX.Element {
  const state = controllerView(props);
  const retry = {
    get error(): string | undefined {
      return state().error;
    },
    onRetry: (): void => void props.controller.load(),
  };
  return (
    <Collection
      empty={
        <div class="mt-6 rounded-2xl border border-dashed border-white/15 p-4 text-sm leading-6 text-slate-400 sm:p-6">
          {props.configuration.emptyMessage}
        </div>
      }
      items={state().credentials}
      listClass="mt-6 space-y-3"
      loading={
        <p class="mt-6 text-sm text-slate-400" role="status">
          {`Loading ${props.configuration.name} ${props.configuration.id === "brave-search" ? "keys" : "connections"}…`}
        </p>
      }
      retry={retry}
    >
      {(credential) => {
        const item: CredentialItemProps = {
          configuration: props.configuration,
          controller: props.controller,
          credential,
          onOpenSessionReassignment: props.onOpenSessionReassignment,
          ...(props.selectedWorkspaceId === undefined
            ? {}
            : { selectedWorkspaceId: props.selectedWorkspaceId }),
          state: state(),
          ...optionalWorkspaces(props.workspaces),
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

interface CredentialTextInputProps {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
  readonly maxLength?: number;
  readonly name: string;
  readonly placeholder: string;
  readonly type: "text" | "url";
}

function CredentialTextInput(props: CredentialTextInputProps): JSX.Element {
  return (
    <FormField
      control={
        <input
          {...credentialInputAttributes(props.disabled)}
          id={props.id}
          maxLength={props.maxLength}
          name={props.name}
          placeholder={props.placeholder}
          required
          type={props.type}
        />
      }
      id={props.id}
      label={props.label}
    />
  );
}

function providerFormLayout(configuration: ProviderPanelConfiguration): string {
  if (configuration.apiFormatSelectable === true) {
    return "md:grid-cols-2 xl:grid-cols-[minmax(0,0.6fr)_minmax(0,0.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]";
  }
  if (configuration.baseUrlPlaceholder !== undefined) {
    return "md:grid-cols-2 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,1fr)_auto]";
  }
  return configuration.keyRequiresLabel === true
    ? "md:grid-cols-2 xl:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto]"
    : "md:grid-cols-[minmax(0,1fr)_auto]";
}

function credentialTextInputs(
  configuration: ProviderPanelConfiguration,
): readonly Omit<CredentialTextInputProps, "disabled">[] {
  const fields: Omit<CredentialTextInputProps, "disabled">[] = [];
  if (configuration.keyRequiresLabel === true) {
    fields.push({
      id: `${configuration.id}-key-label`,
      label: "Label",
      maxLength: 100,
      name: "label",
      placeholder: "Primary",
      type: "text",
    });
  }
  if (configuration.baseUrlPlaceholder !== undefined) {
    fields.push({
      id: `${configuration.id}-base-url`,
      label: "API base URL",
      name: "baseUrl",
      placeholder: configuration.baseUrlPlaceholder,
      type: "url",
    });
  }
  return fields;
}

export function ProviderPanel(props: ProviderPanelProps): JSX.Element {
  const state = controllerView(props);
  const titleId = (): string => `${props.configuration.id}-title`;
  const inputId = (): string => `${props.configuration.id}-api-key`;
  const [form, setForm] = createSignal<HTMLFormElement>();
  const [reassignmentTrigger, setReassignmentTrigger] =
    createSignal<HTMLElement>();
  const reassignmentDialog = new SessionReassignmentDialogController();
  const addCredential = async (
    apiKey: string,
    label: string | undefined,
    baseUrl: string | undefined,
    apiFormat: string | undefined,
  ): Promise<void> => {
    await props.controller.add(apiKey, label, baseUrl, apiFormat);
    form()?.reset();
  };

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
        class={`mt-7 grid min-w-0 gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4 ${providerFormLayout(props.configuration)}`}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const apiFormat = data.get("apiFormat");
          const apiKey = data.get("apiKey");
          const baseUrl = data.get("baseUrl");
          const label = data.get("label");
          if (typeof apiKey === "string") {
            void addCredential(
              apiKey,
              typeof label === "string" ? label : undefined,
              typeof baseUrl === "string" ? baseUrl : undefined,
              typeof apiFormat === "string" ? apiFormat : undefined,
            );
          }
        }}
        ref={setForm}
        {...renderDebugBoundary(
          `provider-form:${props.configuration.id}`,
          `${props.configuration.name} key form`,
        )}
      >
        <For each={credentialTextInputs(props.configuration)}>
          {(field) => (
            <CredentialTextInput {...field} disabled={state().savePending} />
          )}
        </For>
        <Show when={props.configuration.apiFormatSelectable === true}>
          <FormField
            control={
              <select
                {...credentialInputAttributes(state().savePending)}
                id={`${props.configuration.id}-api-format`}
                name="apiFormat"
              >
                <option value="openai">OpenAI chat completions</option>
                <option value="anthropic">Anthropic messages</option>
              </select>
            }
            id={`${props.configuration.id}-api-format`}
            label="API format"
          />
        </Show>
        <div>
          <label class="text-sm font-medium text-slate-200" for={inputId()}>
            {`${props.configuration.name} API key${props.configuration.keyRequired === false ? " (optional)" : ""}`}
          </label>
          <input
            {...credentialInputAttributes(state().savePending)}
            id={inputId()}
            name="apiKey"
            placeholder={props.configuration.keyPlaceholder}
            required={props.configuration.keyRequired !== false}
            type="password"
          />
        </div>
        <button
          class="min-h-11 self-end rounded-xl border border-emerald-300/30 bg-emerald-300/10 px-5 py-3 font-semibold text-emerald-200 transition hover:bg-emerald-300/20 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 md:justify-self-start xl:justify-self-auto"
          disabled={state().savePending}
          type="submit"
        >
          {state().savePending
            ? "Adding…"
            : props.configuration.id === "generic"
              ? "Add provider"
              : "Add API key"}
        </button>
      </form>

      <Show when={state().sessionReassignmentNotice}>
        {(notice) => (
          <p
            class="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100"
            role="status"
          >
            {notice()}
          </p>
        )}
      </Show>
      <ProviderCredentialList
        configuration={props.configuration}
        controller={props.controller}
        onOpenSessionReassignment={(credential, trigger) => {
          setReassignmentTrigger(trigger);
          reassignmentDialog.open(credential);
        }}
        {...optionalWorkspaces(props.workspaces)}
      />
      <p class="mt-5 text-xs leading-5 text-slate-500">
        {props.configuration.removalHelp}
      </p>
      <Show when={props.configuration.id !== "brave-search"}>
        <SessionReassignmentDialog
          configuration={props.configuration}
          controller={reassignmentDialog}
          onConfirm={() => {
            void props.controller.confirmSessionReassignment(
              reassignmentDialog,
            );
          }}
          returnFocus={reassignmentTrigger}
        />
      </Show>
    </section>
  );
}

export interface ProviderPanelController {
  readonly view: Accessor<ProviderViewState>;
  add(...input: ProviderCredentialAddInput): Promise<void>;
  load(): Promise<void>;
  loadQuota(credentialId: string): Promise<void>;
  consumeQuotaReset(
    credentialId: string,
  ): Promise<ProviderQuotaResetOutcome | undefined>;
  setQuotaThreshold(credentialId: string, threshold: number): Promise<void>;
  confirmSessionReassignment(
    dialog: SessionReassignmentDialogController,
  ): Promise<void>;
  remove(credentialId: string): Promise<void>;
  setDefault(credentialId: string): Promise<void>;
  setScopes(
    credentialId: string,
    workspaceIds: readonly string[],
  ): Promise<void>;
}
