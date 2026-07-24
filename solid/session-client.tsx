import { createMemo, Show, type JSX } from "solid-js";
import {
  reasoningEffortLabel,
  type AgentModelCatalog,
} from "../shared/agent-configuration.ts";
import type { AgentImage } from "../shared/agent-images.ts";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { RetryNotice } from "./collection.tsx";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
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
import { SessionPromptInput } from "./session-client-forms.tsx";
import { formatTokenCount } from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { SessionToolPicker } from "./session-tool-picker.tsx";
import type { SessionTranscriptFilters } from "./session-transcript-filters.ts";

export interface SessionDraft {
  readonly credential: string;
  readonly images: readonly AgentImage[];
  readonly model: string;
  readonly prompt: string;
  readonly reasoningEffort: string;
  readonly runnerId: string;
  readonly tools: readonly AgentSessionToolName[];
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
  readonly transcriptFilters: SessionTranscriptFilters;
}

export interface CredentialOption {
  readonly credential: ProviderCredential;
  readonly provider: ProviderId;
}

export function onlineRunners(
  state: RunnerViewState,
): readonly RunnerSummary[] {
  return state.runners?.filter(({ status }) => status === "online") ?? [];
}

function providerIsLoading(state: ProviderViewState): boolean {
  return state.credentials === undefined && state.error === undefined;
}

export function credentialFallbackReady(
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
): boolean {
  return !providerIsLoading(openAi) && !providerIsLoading(openRouter);
}

export function credentialOptions(
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
  };
}

function DirectoryInput(props: {
  readonly controller: SessionController;
  readonly onOpenDirectoryPicker: () => void;
  readonly runnerAvailable: boolean;
  readonly state: SessionViewState;
}): JSX.Element {
  const options = () => ({
    disabled: props.state.creating,
    label: "Working directory on runner",
    name: "workingDirectory",
  });

  const openDirectoryPicker = (): void => {
    props.onOpenDirectoryPicker();
  };

  return renderSessionField(
    "session-directory",
    options().label,
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="min-w-0 flex-1">
        <input
          {...sessionControlAttributes(options(), true)}
          onInput={(event) => {
            props.controller.setDraftField(
              "workingDirectory",
              event.currentTarget.value,
            );
          }}
          placeholder="/path/to/project"
          type="text"
          value={props.state.draft.workingDirectory}
        />
        <code
          class="path-wrap mt-1 block min-w-0 text-xs text-slate-500"
          data-draft-working-directory="true"
        >
          {props.state.draft.workingDirectory}
        </code>
      </div>
      <button
        class="min-h-11 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-2 sm:self-start"
        disabled={props.state.creating || !props.runnerAvailable}
        onClick={openDirectoryPicker}
        type="button"
      >
        Browse
      </button>
    </div>,
  );
}

function credentialSelectOptionsFor(
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

function defaultAvailableConnectionId(
  connections: readonly { readonly id: string; readonly isDefault: boolean }[],
): string {
  return (
    connections.find(({ isDefault }) => isDefault)?.id ??
    connections[0]?.id ??
    ""
  );
}

export function defaultRunnerId(runners: readonly RunnerSummary[]): string {
  return defaultAvailableConnectionId(runners);
}

export function defaultCredentialValue(
  credentials: readonly CredentialOption[],
): string {
  const credentialId = defaultAvailableConnectionId(
    credentials.map(({ credential }) => credential),
  );
  const credential = credentials.find(
    ({ credential }) => credential.id === credentialId,
  );
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

function modelAvailabilityAttributes(
  creating: boolean,
  models: AgentModelCatalog["models"],
): { readonly disabled: boolean } {
  return { disabled: creating || models.length === 0 };
}

function ModelDiscoveryError(props: {
  readonly controller: SessionController;
  readonly visible: boolean;
}): JSX.Element {
  return (
    <Show when={props.visible}>
      <RetryNotice
        error="We could not discover models for that credential."
        onRetry={() => {
          props.controller.retryModels();
        }}
        retryLabel="Retry model discovery"
      />
    </Show>
  );
}

export function NewSessionForm(props: {
  readonly controller: SessionController;
  readonly credentials: readonly CredentialOption[];
  readonly credentialsSettled: boolean;
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly state: SessionViewState;
}): JSX.Element {
  const runners = createMemo(() => props.runners);
  const credentials = createMemo(() => props.credentials);
  const runnerOptions = createMemo(() => runnerSelectOptions(runners()));
  const selectedRunnerId = createMemo(() =>
    selectValue(
      runnerOptions(),
      props.state.draft.runnerId,
      defaultRunnerId(runners()),
    ),
  );
  const credentialSelectOptions = createMemo(() =>
    credentialSelectOptionsFor(credentials()),
  );
  const selectedCredentialValue = createMemo(() =>
    selectValue(
      credentialSelectOptions(),
      props.state.draft.credential,
      props.credentialsSettled ? defaultCredentialValue(credentials()) : "",
    ),
  );
  const credential = createMemo(() =>
    selectedCredential(credentials(), selectedCredentialValue()),
  );
  const discovery = createMemo(() => {
    const selected = credential();
    const value = selected === undefined ? undefined : optionValue(selected);
    return props.state.modelDiscovery.credential === value
      ? props.state.modelDiscovery
      : undefined;
  });
  const models = createMemo(() => discovery()?.catalog?.models ?? []);
  const modelValue = createMemo(() =>
    models().some(({ id }) => id === props.state.draft.model)
      ? props.state.draft.model
      : (models()[0]?.id ?? ""),
  );
  const model = createMemo(() =>
    models().find(({ id }) => id === modelValue()),
  );
  const resourcesAvailable = createMemo(
    () => runners().length > 0 && credentials().length > 0,
  );
  const available = createMemo(
    () =>
      resourcesAvailable() &&
      selectedRunnerId().length > 0 &&
      credential() !== undefined &&
      models().length > 0,
  );

  const optionValues = (
    options: readonly CustomSelectOption[],
  ): readonly string[] => options.map(({ value }) => value);
  const select = (
    name: "credential" | "model" | "reasoningEffort" | "runnerId",
    value: string,
    values: readonly string[],
  ): void => {
    props.controller.chooseOption(name, value, values);
  };
  const toggleSelect = (
    name: "credential" | "model" | "reasoningEffort" | "runnerId",
  ): void => {
    props.controller.toggleSelect(name);
  };

  return (
    <form
      class="mt-6 grid min-w-0 gap-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 md:grid-cols-2 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void props.controller.create();
      }}
    >
      <CustomSelect
        disabled={props.state.creating || runners().length === 0}
        emptyLabel="No online runners"
        id="session-runner"
        label="Runner"
        name="runnerId"
        onChoose={(value) => {
          select("runnerId", value, optionValues(runnerOptions()));
        }}
        onToggle={() => {
          toggleSelect("runnerId");
        }}
        open={props.state.openSelect === "runnerId"}
        options={runnerOptions()}
        required
        selectedValue={selectedRunnerId()}
      />
      <CustomSelect
        disabled={props.state.creating || credentials().length === 0}
        emptyLabel={
          props.credentialsSettled
            ? "No model credentials"
            : "Loading credentials…"
        }
        id="session-credential"
        label="Model credential"
        name="credential"
        onChoose={(value) => {
          select("credential", value, optionValues(credentialSelectOptions()));
        }}
        onToggle={() => {
          toggleSelect("credential");
        }}
        open={props.state.openSelect === "credential"}
        options={credentialSelectOptions()}
        required
        selectedValue={selectedCredentialValue()}
      />
      <DirectoryInput
        controller={props.controller}
        onOpenDirectoryPicker={props.onOpenDirectoryPicker}
        runnerAvailable={selectedRunnerId().length > 0}
        state={props.state}
      />
      <CustomSelect
        {...modelAvailabilityAttributes(props.state.creating, models())}
        emptyLabel={
          discovery()?.error === undefined
            ? credential() !== undefined &&
              (discovery() === undefined || discovery()?.loading === true)
              ? "Loading models…"
              : "No compatible models"
            : "Models unavailable"
        }
        id="session-model"
        label="Model"
        name="model"
        onChoose={(value) => {
          select(
            "model",
            value,
            modelSelectOptions(models()).map(({ value }) => value),
          );
        }}
        onToggle={() => {
          toggleSelect("model");
        }}
        open={props.state.openSelect === "model"}
        options={modelSelectOptions(models())}
        required
        selectedValue={modelValue()}
      />
      <CustomSelect
        disabled={
          modelAvailabilityAttributes(props.state.creating, models())
            .disabled || (model()?.reasoningEfforts.length ?? 0) === 0
        }
        emptyLabel="Model default"
        id="session-reasoning-effort"
        label="Reasoning effort"
        name="reasoningEffort"
        onChoose={(value) => {
          select("reasoningEffort", value, [
            "",
            ...(model()?.reasoningEfforts ?? []),
          ]);
        }}
        onToggle={() => {
          toggleSelect("reasoningEffort");
        }}
        open={props.state.openSelect === "reasoningEffort"}
        options={[
          { label: "Model default", value: "" },
          ...(model()?.reasoningEfforts ?? []).map((effort) => ({
            label: reasoningEffortLabel(effort),
            value: effort,
          })),
        ]}
        required={false}
        selectedValue={props.state.draft.reasoningEffort}
      />
      {renderModelModalities(model())}
      <SessionToolPicker
        disabled={props.state.creating}
        onChange={(tools) => {
          props.controller.setTools(tools);
        }}
        tools={props.state.draft.tools}
      />
      <SessionPromptInput
        disabled={props.state.creating}
        images={props.state.draft.images}
        onAddImages={(files) => {
          void props.controller.addImages(files, false);
        }}
        onInput={(value) => {
          props.controller.setDraftField("prompt", value);
        }}
        onRemoveImage={(index) => {
          props.controller.removeImage(index, "draft");
        }}
        prompt={props.state.draft.prompt}
      />
      <div class="flex min-w-0 flex-col gap-3 md:col-span-2 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-xs leading-5 text-slate-500">
          The model runs through Q Mush; file and shell tools run only on the
          selected runner.
        </p>
        <button
          class="shrink-0 rounded-xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={props.state.creating || !available()}
          type="submit"
        >
          {props.state.creating ? "Starting…" : "Start session"}
        </button>
      </div>
      <Show when={!resourcesAvailable()}>
        <p class="text-sm text-amber-200 md:col-span-2">
          Connect an online runner and add a provider credential before starting
          a session.
        </p>
      </Show>
      <ModelDiscoveryError
        controller={props.controller}
        visible={resourcesAvailable() && discovery()?.error !== undefined}
      />
    </form>
  );
}
