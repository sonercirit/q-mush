import {
  reasoningEffortLabel,
  type AgentModelCatalog,
} from "./agent-configuration.ts";
import { renderRetryError } from "./client-controls.tsx";
import { renderDirectoryPicker } from "./directory-picker-client.tsx";
import type { DirectoryPickerState } from "./directory-picker-controller.ts";
import { createElement, type JsxNode } from "./jsx.ts";
import type {
  ProviderCredential,
  ProviderViewState,
} from "./provider-client.tsx";
import type { ProviderId } from "./provider-credential-store.ts";
import type { RunnerViewState } from "./runner-client.tsx";
import type { RunnerSummary } from "./runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionStatus,
  AgentSessionSummary,
} from "./session-model.ts";
import { renderSessionTranscript } from "./session-transcript.tsx";

export interface SessionDraft {
  readonly credential: string;
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
  readonly creating: boolean;
  readonly directoryPicker: DirectoryPickerState;
  readonly detail: AgentSessionDetail | undefined;
  readonly draft: SessionDraft;
  readonly error: string | undefined;
  readonly followUp: string;
  readonly loadingDetail: boolean;
  readonly modelDiscovery: SessionModelDiscoveryState;
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

function statusBadge(status: AgentSessionStatus): JsxNode {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${presentation.classes}`}
    >
      {presentation.label}
    </span>
  );
}

function onlineRunners(state: RunnerViewState): readonly RunnerSummary[] {
  return state.runners?.filter(({ status }) => status === "online") ?? [];
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
  return (
    credentials.find((option) => optionValue(option) === value) ??
    credentials[0]
  );
}

function renderSelectOptions(
  options: readonly { readonly label: string; readonly value: string }[],
  selectedValue: string,
): JsxNode {
  return options.map((option) => (
    <option selected={selectedValue === option.value} value={option.value}>
      {option.label}
    </option>
  ));
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
  label: JsxNode,
  control: JsxNode,
): JsxNode {
  return (
    <div>
      <label className="text-sm font-medium text-slate-200" htmlFor={id}>
        {label}
      </label>
      {control}
    </div>
  );
}

interface SessionControlOptions {
  readonly disabled: boolean;
  readonly id: string;
  readonly label: string;
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
    id: options.id,
    name: options.name,
    required,
  };
}

function renderDirectoryInput(
  state: SessionViewState,
  runnerAvailable: boolean,
): JsxNode {
  const options = {
    disabled: state.creating,
    id: "session-directory",
    label: "Working directory on runner",
    name: "workingDirectory",
  };

  return renderSessionField(
    options.id,
    options.label,
    <div className="flex items-center gap-2">
      <input
        {...sessionControlAttributes(options, true)}
        placeholder="/path/to/project"
        type="text"
        value={state.draft.workingDirectory}
      />
      <button
        className="mt-2 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
        data-action="open-directory-picker"
        disabled={state.creating || !runnerAvailable}
        type="button"
      >
        Browse
      </button>
    </div>,
  );
}

function renderSessionSelect(
  options: SessionControlOptions & {
    readonly children: JsxNode;
    readonly required?: boolean;
  },
): JsxNode {
  return renderSessionField(
    options.id,
    options.label,
    <select {...sessionControlAttributes(options, options.required !== false)}>
      {options.children}
    </select>,
  );
}

function renderNewSessionForm(
  state: SessionViewState,
  runners: readonly RunnerSummary[],
  credentials: readonly CredentialOption[],
): JsxNode {
  const resourcesAvailable = runners.length > 0 && credentials.length > 0;
  const credential = selectedCredential(credentials, state.draft.credential);
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
    : (catalog?.defaultModel ?? models[0]?.id ?? "");
  const model = models.find(({ id }) => id === modelValue);
  const loadingModels =
    credential !== undefined && (discovery === undefined || discovery.loading);
  const available = resourcesAvailable && models.length > 0;

  return (
    <form
      className="mt-6 grid gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-5 lg:grid-cols-2"
      data-action="create-session"
    >
      {renderSessionSelect({
        children: runners.map((runner) => (
          <option
            selected={state.draft.runnerId === runner.id}
            value={runner.id}
          >
            {runner.name ?? "Online runner"}
          </option>
        )),
        disabled: state.creating || runners.length === 0,
        id: "session-runner",
        label: "Runner",
        name: "runnerId",
      })}
      {renderSessionSelect({
        children: credentials.map((option) => (
          <option
            selected={state.draft.credential === optionValue(option)}
            value={optionValue(option)}
          >
            {`${option.provider === "openai" ? "OpenAI" : "OpenRouter"} · ${option.credential.label}`}
          </option>
        )),
        disabled: state.creating || credentials.length === 0,
        id: "session-credential",
        label: "Model credential",
        name: "credential",
      })}
      {renderDirectoryInput(state, runners.length > 0)}
      {renderSessionSelect({
        children:
          models.length === 0 ? (
            <option value="">
              {discovery?.error === undefined
                ? loadingModels
                  ? "Loading models…"
                  : "No compatible models"
                : "Models unavailable"}
            </option>
          ) : (
            renderSelectOptions(
              models.map(({ id, label }) => ({ label, value: id })),
              modelValue,
            )
          ),
        disabled: state.creating || models.length === 0,
        id: "session-model",
        label: "Model",
        name: "model",
      })}
      {renderSessionSelect({
        children: renderSelectOptions(
          [
            { label: "Model default", value: "" },
            ...(model?.reasoningEfforts ?? []).map((effort) => ({
              label: reasoningEffortLabel(effort),
              value: effort,
            })),
          ],
          state.draft.reasoningEffort,
        ),
        disabled: state.creating || (model?.reasoningEfforts.length ?? 0) === 0,
        id: "session-reasoning-effort",
        label: "Reasoning effort",
        name: "reasoningEffort",
        required: false,
      })}
      <div className="lg:col-span-2">
        <label
          className="text-sm font-medium text-slate-200"
          htmlFor="session-prompt"
        >
          Task
        </label>
        <textarea
          className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm leading-6 text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
          disabled={state.creating}
          id="session-prompt"
          name="prompt"
          placeholder="Describe the change you want the agent to make…"
          required
        >
          {state.draft.prompt}
        </textarea>
      </div>
      <div className="flex flex-col gap-3 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-slate-500">
          The model runs through Q Mush; file and shell tools run only on the
          selected runner.
        </p>
        <button
          className="shrink-0 rounded-xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={state.creating || !available}
          type="submit"
        >
          {state.creating ? "Starting…" : "Start session"}
        </button>
      </div>
      {!resourcesAvailable ? (
        <p className="text-sm text-amber-200 lg:col-span-2">
          Connect an online runner and add a provider credential before starting
          a session.
        </p>
      ) : discovery?.error !== undefined ? (
        <p className="flex items-center gap-3 text-sm text-amber-200 lg:col-span-2">
          We could not discover models for that credential.
          <button
            className="font-semibold underline underline-offset-4"
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

function renderSessionList(state: SessionViewState): JsxNode {
  if (state.sessions === undefined) {
    return <p className="text-sm text-slate-400">Loading sessions…</p>;
  }

  if (state.sessions.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-white/15 p-5 text-sm leading-6 text-slate-400">
        No sessions yet. Start one above to give an agent a task.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {state.sessions.map((session) => (
        <li>
          <button
            className={`w-full rounded-2xl border p-4 text-left transition ${state.selectedId === session.id ? "border-emerald-300/30 bg-emerald-300/10" : "border-white/10 bg-slate-950/60 hover:border-white/20"}`}
            data-action="select-session"
            data-session-id={session.id}
            type="button"
          >
            <span className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block truncate font-semibold text-white">
                  {session.title}
                </span>
                <span className="mt-1 block truncate text-xs text-slate-500">
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

function renderDetail(state: SessionViewState): JsxNode {
  if (state.selectedId === undefined) {
    return (
      <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/15 text-sm text-slate-500">
        Select a session to view its transcript.
      </div>
    );
  }

  if (state.loadingDetail || state.detail === undefined) {
    return <p className="text-sm text-slate-400">Loading transcript…</p>;
  }

  const detail = state.detail;
  const active = detail.status === "queued" || detail.status === "running";
  const lastMessageId = detail.messages.at(-1)?.id ?? "";
  const agentFileRevision =
    detail.agentFile === null
      ? "none"
      : `${detail.agentFile.name}:${String(detail.agentFile.content.length)}`;
  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-xl font-semibold text-white">{detail.title}</h3>
            {statusBadge(detail.status)}
          </div>
          <p className="mt-2 truncate text-xs text-slate-500">
            {`${sessionModelLabel(detail)} · ${detail.workingDirectory} · Agent file: ${detail.agentFile?.name ?? "None"}`}
          </p>
        </div>
        {active ? (
          <button
            className="shrink-0 rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2 text-sm font-semibold text-rose-200 disabled:opacity-50"
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
        className="mt-5 max-h-[36rem] space-y-3 overflow-y-auto pr-1"
        data-scroll-key={`session-transcript:${detail.id}`}
        data-scroll-on-change="end"
        data-scroll-revision={`${agentFileRevision}:${String(detail.messages.length)}:${lastMessageId}`}
      >
        {renderSessionTranscript(detail.messages, detail.agentFile)}
      </ul>
      {!active ? (
        <form className="mt-5 flex gap-3" data-action="send-session-message">
          <textarea
            className="min-h-20 min-w-0 flex-1 resize-y rounded-xl border border-white/10 bg-slate-950 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
            disabled={state.sending}
            name="prompt"
            placeholder="Give this session another instruction…"
            required
          >
            {state.followUp}
          </textarea>
          <button
            className="self-end rounded-xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
            disabled={state.sending}
            type="submit"
          >
            {state.sending ? "Sending…" : "Send"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

export function renderSessionPanel(
  state: SessionViewState,
  runnerState: RunnerViewState,
  openAiState: ProviderViewState,
  openRouterState: ProviderViewState,
): JsxNode {
  const runners = onlineRunners(runnerState);
  const credentials = credentialOptions(openAiState, openRouterState);
  const selectedRunner = runners.find(
    ({ id }) => id === state.directoryPicker.runnerId,
  );

  return (
    <div data-session-panel="true">
      <section
        inert={state.directoryPicker.open}
        aria-labelledby="agent-sessions-title"
        className="rounded-3xl border border-emerald-300/15 bg-white/[0.06] p-6 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-8"
      >
        <p className="text-sm font-medium text-emerald-300">
          First-party agent runtime
        </p>
        <h2
          className="mt-2 text-2xl font-semibold text-white"
          id="agent-sessions-title"
        >
          New agent session
        </h2>
        <p className="mt-3 max-w-3xl leading-7 text-slate-400">
          Start and steer coding sessions on your connected computers. Q Mush
          owns the model loop and runner tools end to end.
        </p>
        {renderNewSessionForm(state, runners, credentials)}
        {renderRetryError(state.error, "retry-sessions")}
        <div className="mt-7 grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside aria-label="Agent sessions">{renderSessionList(state)}</aside>
          <div className="min-w-0 rounded-2xl border border-white/10 bg-slate-900/70 p-5">
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
