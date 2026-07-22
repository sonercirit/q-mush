import { type JSX } from "solid-js";
import {
  reasoningEffortLabel,
  type AgentModelCatalog,
} from "../shared/agent-configuration.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { renderRetryError } from "./client-controls.tsx";
import {
  renderCustomSelect,
  type CustomSelectOption,
} from "./custom-select.tsx";
import { renderDirectoryPicker } from "./directory-picker-client.tsx";
import type { DirectoryPickerState } from "./directory-picker-controller.ts";
import {
  modelModalitiesLabel,
  renderModelModalities,
} from "./model-modalities-client.tsx";
import type {
  ProviderCredential,
  ProviderViewState,
} from "./provider-client.tsx";
import type { RunnerViewState } from "./runner-client.tsx";
import {
  renderSessionFollowUp,
  renderSessionPromptInput,
} from "./session-client-forms.tsx";
import {
  formatTokenCount,
  renderCompactionControls,
  sessionContextClasses,
  sessionContextLabel,
} from "./session-context-client.tsx";
import { renderSessionTranscript } from "./session-transcript.tsx";

export interface SessionDraft {
  readonly credential: string;
  readonly images: readonly AgentImage[];
  readonly model: string;
  readonly prompt: string;
  readonly reasoningEffort: string;
  readonly runnerId: string;
  readonly workingDirectory: string;
}

export interface SessionModelDiscoveryState {
  readonly catalog: AgentModelCatalog | undefined;
  readonly credential: string | undefined;
  readonly error: string | undefined;
  readonly loading: boolean;
}

export interface SessionViewState {
  readonly compacting: boolean;
  readonly creating: boolean;
  readonly directoryPicker: DirectoryPickerState;
  readonly detail: AgentSessionDetail | undefined;
  readonly draft: SessionDraft;
  readonly error: string | undefined;
  readonly followUp: string;
  readonly followUpImages: readonly AgentImage[];
  readonly loadingDetail: boolean;
  readonly modelDiscovery: SessionModelDiscoveryState;
  readonly openSelect:
    "credential" | "model" | "reasoningEffort" | "runnerId" | undefined;
  readonly selectedId: string | undefined;
  readonly sending: boolean;
  readonly sessions: readonly AgentSessionSummary[] | undefined;
  readonly stopping: boolean;
}

interface CredentialOption {
  readonly credential: ProviderCredential;
  readonly provider: ProviderId;
}

const STATUS_PRESENTATION: Readonly<
  Record<
    AgentSessionStatus,
    { readonly classes: string; readonly label: string }
  >
> = {
  failed: {
    classes: "border-rose-300/20 bg-rose-300/10 text-rose-200",
    label: "Failed",
  },
  idle: {
    classes: "border-cyan-300/20 bg-cyan-300/10 text-cyan-200",
    label: "Ready",
  },
  queued: {
    classes: "border-amber-300/20 bg-amber-300/10 text-amber-200",
    label: "Queued",
  },
  running: {
    classes: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
    label: "Running",
  },
  stopped: {
    classes: "border-slate-400/20 bg-slate-400/10 text-slate-300",
    label: "Stopped",
  },
};

function statusBadge(status: AgentSessionStatus): JSX.Element {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span
      class={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      {presentation.label}
    </span>
  );
}

function onlineRunners(state: RunnerViewState): readonly RunnerSummary[] {
  return state.runners?.filter(({ status }) => status === "online") ?? [];
}

function providerIsLoading(state: ProviderViewState): boolean {
  return state.credentials === undefined && state.error === undefined;
}

function credentialFallbackReady(
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): boolean {
  return !providerIsLoading(openAi) && !providerIsLoading(openRouter);
}

function credentialOptions(
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): readonly CredentialOption[] {
  return [
    ...(openAi.credentials ?? []).map((credential) => ({
      credential,
      provider: "openai" as const,
    })),
    ...(openRouter.credentials ?? []).map((credential) => ({
      credential,
      provider: "openrouter" as const,
    })),
  ];
}

function optionValue(option: CredentialOption): string {
  return `${option.provider}:${option.credential.id}`;
}

function selectedCredential(
  credentials: readonly CredentialOption[],
  value: string,
): CredentialOption | undefined {
  return credentials.find((option) => optionValue(option) === value);
}

function sessionModelLabel(
  session: Pick<AgentSessionSummary, "model" | "provider" | "reasoningEffort">,
): string {
  const model = `${session.provider} · ${session.model}`;
  return session.reasoningEffort === null
    ? model
    : `${model} · ${reasoningEffortLabel(session.reasoningEffort)} reasoning`;
}

function renderSessionField(
  id: string,
  label: JSX.Element,
  control: JSX.Element,
): JSX.Element {
  return (
    <div>
      <label class="text-sm font-medium text-slate-200" for={id}>
        {label}
      </label>
      {control}
    </div>
  );
}

interface SessionControlOptions {
  readonly disabled: boolean;
  readonly name: string;
}

function sessionControlAttributes(
  options: SessionControlOptions,
  required: boolean,
) {
  return {
    className:
      "mt-2 min-w-0 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none",
    disabled: options.disabled,
    id: "session-directory",
    name: options.name,
    required,
    "data-focus-key": "session-directory",
  };
}

function renderDirectoryInput(
  state: SessionViewState,
  runnerAvailable: boolean,
): JSX.Element {
  const options = {
    disabled: state.creating,
    label: "Working directory on runner",
    name: "workingDirectory",
  };

  return renderSessionField(
    "session-directory",
    options.label,
    <div class="flex items-center gap-2">
      <input
        {...sessionControlAttributes(options, true)}
        placeholder="/path/to/project"
        type="text"
        value={state.draft.workingDirectory}
      />
      <button
        class="mt-2 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
        data-action="open-directory-picker"
        disabled={state.creating || !runnerAvailable}
        type="button"
      >
        Browse
      </button>
    </div>,
  );
}

function credentialSelectOptions(
  credentials: readonly CredentialOption[],
): readonly CustomSelectOption[] {
  return credentials.map((option) => ({
    label: `${option.provider === "openai" ? "OpenAI" : "OpenRouter"} · ${option.credential.label}`,
    value: optionValue(option),
  }));
}

function runnerSelectOptions(
  runners: readonly RunnerSummary[],
): readonly CustomSelectOption[] {
  return runners.map((runner) => ({
    label: runner.name ?? "Online runner",
    value: runner.id,
  }));
}

function selectValue(
  options: readonly CustomSelectOption[],
  requested: string,
  fallback: string,
): string {
  return options.some((option) => option.value === requested)
    ? requested
    : fallback;
}

function defaultRunnerId(runners: readonly RunnerSummary[]): string {
  return runners.find(({ isDefault }) => isDefault)?.id ?? runners[0]?.id ?? "";
}

function defaultCredentialValue(
  credentials: readonly CredentialOption[],
): string {
  const credential =
    credentials.find((option) => option.credential.isDefault) ?? credentials[0];
  return credential === undefined ? "" : optionValue(credential);
}

function modelSelectOptions(
  models: AgentModelCatalog["models"],
): readonly CustomSelectOption[] {
  return models.map((model) => ({
    description: modelModalitiesLabel(model),
    ...(model.contextWindow === null
      ? {}
      : { detail: `${formatTokenCount(model.contextWindow)} context` }),
    label: model.label,
    value: model.id,
  }));
}

function renderNewSessionForm(
  state: SessionViewState,
  runners: readonly RunnerSummary[],
  credentials: readonly CredentialOption[],
  credentialsSettled: boolean,
): JSX.Element {
  const resourcesAvailable = runners.length > 0 && credentials.length > 0;
  const runnerOptions = runnerSelectOptions(runners);
  const selectedRunnerId = selectValue(
    runnerOptions,
    state.draft.runnerId,
    defaultRunnerId(runners),
  );
  const credentialOptions = credentialSelectOptions(credentials);
  const selectedCredentialValue = selectValue(
    credentialOptions,
    state.draft.credential,
    credentialsSettled ? defaultCredentialValue(credentials) : "",
  );
  const credential = selectedCredential(credentials, selectedCredentialValue);
  const credentialValue =
    credential === undefined ? undefined : optionValue(credential);
  const discovery =
    state.modelDiscovery.credential === credentialValue
      ? state.modelDiscovery
      : undefined;
  const catalog = discovery?.catalog;
  const models = catalog?.models ?? [];
  const modelValue = models.some(({ id }) => id === state.draft.model)
    ? state.draft.model
    : (models[0]?.id ?? "");
  const model = models.find(({ id }) => id === modelValue);
  const loadingModels =
    credential !== undefined && (discovery === undefined || discovery.loading);
  const available =
    resourcesAvailable &&
    selectedRunnerId.length > 0 &&
    credential !== undefined &&
    models.length > 0;

  return (
    <form
      class="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-5 lg:grid-cols-2"
      data-action="create-session"
    >
      {renderCustomSelect({
        disabled: state.creating || runners.length === 0,
        emptyLabel: "No online runners",
        id: "session-runner",
        label: "Runner",
        name: "runnerId",
        open: state.openSelect === "runnerId",
        options: runnerOptions,
        required: true,
        selectedValue: selectedRunnerId,
      })}
      {renderCustomSelect({
        disabled: state.creating || credentials.length === 0,
        emptyLabel: credentialsSettled
          ? "No model credentials"
          : "Loading credentials…",
        id: "session-credential",
        label: "Model credential",
        name: "credential",
        open: state.openSelect === "credential",
        options: credentialOptions,
        required: true,
        selectedValue: selectedCredentialValue,
      })}
      {renderDirectoryInput(state, selectedRunnerId.length > 0)}
      {renderCustomSelect({
        disabled: state.creating || models.length === 0,
        emptyLabel:
          discovery?.error === undefined
            ? loadingModels
              ? "Loading models…"
              : "No compatible models"
            : "Models unavailable",
        id: "session-model",
        label: "Model",
        name: "model",
        open: state.openSelect === "model",
        options: modelSelectOptions(models),
        required: true,
        selectedValue: modelValue,
      })}
      {renderCustomSelect({
        disabled:
          state.creating ||
          models.length === 0 ||
          (model?.reasoningEfforts.length ?? 0) === 0,
        emptyLabel: "Model default",
        id: "session-reasoning-effort",
        label: "Reasoning effort",
        name: "reasoningEffort",
        open: state.openSelect === "reasoningEffort",
        options: [
          { label: "Model default", value: "" },
          ...(model?.reasoningEfforts ?? []).map((effort) => ({
            label: reasoningEffortLabel(effort),
            value: effort,
          })),
        ],
        required: false,
        selectedValue: state.draft.reasoningEffort,
      })}
      {renderModelModalities(model)}
      {renderSessionPromptInput({
        disabled: state.creating,
        images: state.draft.images,
        prompt: state.draft.prompt,
      })}
      <div class="flex flex-col gap-3 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs leading-5 text-slate-500">
          The model runs through Q Mush; file and shell tools run only on the
          selected runner.
        </p>
        <button
          class="shrink-0 rounded-xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={state.creating || !available}
          type="submit"
        >
          {state.creating ? "Starting…" : "Start session"}
        </button>
      </div>
      {!resourcesAvailable ? (
        <p class="text-sm text-amber-200 lg:col-span-2">
          Connect an online runner and add a provider credential before starting
          a session.
        </p>
      ) : discovery?.error !== undefined ? (
        <p class="flex items-center gap-3 text-sm text-amber-200 lg:col-span-2">
          We could not discover models for that credential.
          <button
            class="font-semibold underline underline-offset-4"
            data-action="retry-models"
            type="button"
          >
            Retry
          </button>
        </p>
      ) : null}
    </form>
  );
}

function renderSessionList(state: SessionViewState): JSX.Element {
  if (state.sessions === undefined) {
    return <p class="text-sm text-slate-400">Loading sessions…</p>;
  }

  if (state.sessions.length === 0) {
    return (
      <p class="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
        No sessions yet. Start one above to give an agent a task.
      </p>
    );
  }

  return (
    <ul class="max-h-144 space-y-2 overflow-y-auto" data-scroll-key="list">
      {state.sessions.map((session) => (
        <li>
          <button
            class={`w-full rounded-2xl border p-4 text-left transition ${state.selectedId === session.id ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
            data-action="select-session"
            data-session-id={session.id}
            type="button"
          >
            <span class="flex items-start justify-between gap-3">
              <span class="min-w-0">
                <span class="block truncate font-semibold text-white">
                  {session.title}
                </span>
                <span class="mt-1 block truncate text-xs text-slate-500">
                  {sessionModelLabel(session)}
                </span>
              </span>
              {statusBadge(session.status)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function renderDetail(state: SessionViewState): JSX.Element {
  if (state.selectedId === undefined) {
    return (
      <div class="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-500">
        Select a session to view its transcript.
      </div>
    );
  }

  if (state.loadingDetail || state.detail === undefined) {
    return <p class="text-sm text-slate-400">Loading transcript…</p>;
  }

  const detail = state.detail;
  const { sending } = state;
  const active = detail.status === "queued" || detail.status === "running";
  const lastMessageId = detail.messages.at(-1)?.id ?? "";
  const agentFileRevision =
    detail.agentFile === null
      ? "none"
      : `${detail.agentFile.name}:${String(detail.agentFile.content.length)}`;
  return (
    <div>
      <div class="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-xl font-semibold text-white">{detail.title}</h3>
            {statusBadge(detail.status)}
          </div>
          <p class={`mt-2 truncate text-xs ${sessionContextClasses(detail)}`}>
            {`${sessionModelLabel(detail)} · ${sessionContextLabel(detail)} · ${detail.workingDirectory} · Agent file: ${detail.agentFile?.name ?? "None"}`}
          </p>
        </div>
        {active ? (
          <button
            class="shrink-0 rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50"
            data-action="stop-session"
            disabled={state.stopping}
            type="button"
          >
            {state.stopping ? "Stopping…" : "Stop session"}
          </button>
        ) : null}
      </div>
      <ul
        aria-live="polite"
        class="mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1"
        data-scroll-key={`session-transcript:${detail.id}`}
        data-scroll-on-change="end"
        data-scroll-revision={`${agentFileRevision}:${String(detail.messages.length)}:${lastMessageId}`}
      >
        {renderSessionTranscript(detail.messages, detail.agentFile)}
      </ul>
      {!active ? (
        <div class="mt-5 flex flex-col gap-3">
          {renderCompactionControls({
            autoCompact: detail.autoCompact,
            compacting: state.compacting,
          })}
          <div class="flex gap-3">
            {renderSessionFollowUp({
              images: state.followUpImages,
              prompt: state.followUp,
              sending,
            })}
            <button
              class="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950"
              data-action="continue-session"
              disabled={sending}
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function renderSessionPanel(
  state: SessionViewState,
  runnerState: RunnerViewState,
  openAiState: ProviderViewState,
  openRouterState: ProviderViewState,
): JSX.Element {
  const runners = onlineRunners(runnerState);
  const credentials = credentialOptions(openAiState, openRouterState);
  const selectedRunner = runners.find(
    ({ id }) => id === state.directoryPicker.runnerId,
  );

  return (
    <div
      data-credentials-settled={String(
        credentialFallbackReady(openAiState, openRouterState),
      )}
      data-session-panel="true"
    >
      <section
        inert={state.directoryPicker.open}
        aria-labelledby="agent-sessions-title"
        class="rounded-3xl border border-emerald-300/15 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      >
        <p class="text-sm font-medium text-emerald-300">
          First-party agent runtime
        </p>
        <h2
          class="mt-2 text-2xl font-semibold text-white"
          id="agent-sessions-title"
        >
          New agent session
        </h2>
        <p class="mt-3 max-w-3xl leading-7 text-slate-400">
          Start and steer coding sessions on your connected computers. Q Mush
          owns the model loop and runner tools end to end.
        </p>
        {renderNewSessionForm(
          state,
          runners,
          credentials,
          credentialFallbackReady(openAiState, openRouterState),
        )}
        {renderRetryError(state.error, "retry-sessions")}
        <div class="mt-7 grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside aria-label="Agent sessions">{renderSessionList(state)}</aside>
          <div class="min-w-0 rounded-2xl border border-white/10 bg-slate-900/70 p-5">
            {renderDetail(state)}
          </div>
        </div>
      </section>
      {renderDirectoryPicker(
        state.directoryPicker,
        selectedRunner?.name ?? "Selected runner",
      )}
    </div>
  );
}
