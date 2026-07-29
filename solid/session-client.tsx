import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import {
  reasoningEffortLabel,
  type AgentModelCatalog,
} from "../shared/agent-configuration.ts";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { RetryNotice } from "./collection.tsx";
import { ControllerRetryNotice } from "./controller-retry.tsx";
import { controllerView } from "./controller-view.ts";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import { DirectoryBrowseButton } from "./directory-browse-button.tsx";
import { DirectoryPicker } from "./directory-picker-client.tsx";
import { findById } from "./id-selection.ts";
import {
  modelModalitiesLabel,
  renderModelModalities,
} from "./model-modalities-client.tsx";
import type { ProviderViewState } from "./provider-client.tsx";
import { renderDebugBoundary } from "./render-debug.tsx";
import type { RunnerViewState } from "./runner-client.tsx";
import { SessionAutoCompactToggle } from "./session-autocompact-toggle.tsx";
import { SessionPromptInput } from "./session-client-forms.tsx";
import { formatTokenCount } from "./session-context-client.tsx";
import type { SessionController } from "./session-controller.ts";
import { credentialOptions } from "./session-credential-list.ts";
import {
  sessionCredentialSelectOptions,
  type SessionCredentialOption,
} from "./session-credential-option.ts";
import { SessionExecutionEnvironmentSelect } from "./session-execution-environment.tsx";
import { SessionResults } from "./session-focus-client.tsx";
import {
  defaultModelCredentialValue,
  defaultOnlineRunnerId,
  selectedOptionValue,
  selectedSessionCredentialOption,
  sessionCredentialOptionValue,
} from "./session-new-selection.ts";
import type { SessionPanelResources } from "./session-panel-resources.ts";
import { OpenRouterProviderSelect } from "./session-provider-select.tsx";
import { runnerSelectOptions } from "./session-reassignment-client.ts";
import { selectedSessionCredentialAvailable } from "./session-resource-availability.ts";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";
import { SessionToolPicker } from "./session-tool-picker.tsx";
import type { SessionViewState } from "./session-view-state.ts";

export type {
  SessionDraft,
  SessionModelDiscoveryState,
  SessionViewState,
} from "./session-view-state.ts";

type CredentialOption = SessionCredentialOption;

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

function optionValue(option: CredentialOption): string {
  return sessionCredentialOptionValue(option);
}

function selectedCredential(
  credentials: readonly CredentialOption[],
  value: string,
): CredentialOption | undefined {
  return selectedSessionCredentialOption(credentials, value);
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
    <>{options().label}</>,
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
      <DirectoryBrowseButton
        class="min-h-11 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50 sm:mt-2 sm:self-start"
        disabled={props.state.creating || !props.runnerAvailable}
        onClick={openDirectoryPicker}
      />
    </div>,
  );
}

const selectValue = selectedOptionValue;
const defaultRunnerId = defaultOnlineRunnerId;
const defaultCredentialValue = defaultModelCredentialValue;

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

function NewSessionForm(
  props: SessionRunnerViewProps & {
    readonly credentials: readonly CredentialOption[];
    readonly credentialsSettled: boolean;
  },
): JSX.Element {
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
    sessionCredentialSelectOptions(credentials()),
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
  const model = createMemo(() => findById(models(), modelValue()));
  const providerDiscoveryKey = createMemo(() =>
    credential()?.provider === "openrouter" && modelValue().length > 0
      ? `${selectedCredentialValue()}\n${modelValue()}`
      : undefined,
  );
  const providerDiscovery = createMemo(() =>
    props.state.providerDiscovery.key === providerDiscoveryKey()
      ? props.state.providerDiscovery
      : undefined,
  );
  createEffect(() => {
    props.controller.ensureProviders(selectedCredentialValue(), modelValue());
  });
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
    name:
      | "credential"
      | "executionEnvironment"
      | "model"
      | "openRouterProviderTag"
      | "reasoningEffort"
      | "runnerId",
    value: string,
    values: readonly string[],
  ): void => {
    props.controller.chooseOption(name, value, values);
  };
  const toggleSelect = (
    name:
      | "credential"
      | "executionEnvironment"
      | "model"
      | "openRouterProviderTag"
      | "reasoningEffort"
      | "runnerId",
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
      <SessionExecutionEnvironmentSelect
        controller={props.controller}
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
      <Show
        when={
          credential()?.provider === "openrouter" && modelValue().length > 0
        }
      >
        <OpenRouterProviderSelect
          controller={props.controller}
          creating={props.state.creating}
          discovery={providerDiscovery()}
          open={props.state.openSelect === "openRouterProviderTag"}
          selectedValue={props.state.draft.openRouterProviderTag}
        />
      </Show>
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
      <SessionAutoCompactToggle
        checked={props.state.draft.autoCompact}
        disabled={props.state.creating}
        onChange={(autoCompact) => {
          props.controller.setDraftAutoCompact(autoCompact);
        }}
      />
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

export function SessionPanel(
  props: SessionPanelResources & { readonly controller: SessionController },
): JSX.Element {
  const state = controllerView(props);
  const online = () => onlineRunners(props.runners());
  const credentials = () =>
    credentialOptions(props.openAi(), props.openRouter());
  const credentialsSettled = () =>
    credentialFallbackReady(props.openAi(), props.openRouter());
  const [focusMode, setFocusMode] = createSignal(false);
  const selectedRunner = (): RunnerSummary | undefined =>
    online().find(
      ({ id }) => id === props.controller.directoryPicker.state.runnerId,
    );

  const openDirectoryPicker = (): void => {
    setFocusMode(false);
    props.controller.openDirectoryPicker();
  };

  createEffect(() => {
    if (props.controller.directoryPicker.view().open) {
      setFocusMode(false);
    }
  });

  createEffect(() => {
    const runnerId = defaultRunnerId(online());
    const credential = defaultCredentialValue(credentials());
    const settled = credentialsSettled();
    untrack(() => {
      props.controller.initializeDefaults(runnerId, credential, settled);
    });
  });

  return (
    <div
      data-credentials-settled={String(credentialsSettled())}
      data-session-panel="true"
    >
      <section
        aria-labelledby="agent-sessions-title"
        class={`rounded-3xl border border-emerald-300/15 bg-white/[0.06] p-4 shadow-2xl shadow-emerald-950/30 backdrop-blur-xl sm:p-6 lg:p-8 ${focusMode() ? "session-panel-focus" : ""}`}
        data-session-panel-focus={String(focusMode())}
        inert={props.controller.directoryPicker.view().open}
        {...renderDebugBoundary("sessions-panel", "Agent sessions panel")}
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
        <NewSessionForm
          controller={props.controller}
          credentials={credentials()}
          credentialsSettled={credentialsSettled()}
          onOpenDirectoryPicker={openDirectoryPicker}
          runners={online()}
          state={state()}
        />
        <ControllerRetryNotice
          error={state().error}
          load={props.controller.load.bind(props.controller)}
        />
        <SessionResults
          controller={props.controller}
          credentialAvailable={selectedSessionCredentialAvailable(
            state().detail,
            props.openAi(),
            props.openRouter(),
          )}
          credentials={credentials()}
          focusMode={focusMode}
          onOpenDirectoryPicker={openDirectoryPicker}
          runners={online()}
          setFocusMode={setFocusMode}
        />
      </section>
      <DirectoryPicker
        controller={props.controller.directoryPicker}
        onChoose={() => {
          props.controller.chooseDirectory();
        }}
        runnerName={selectedRunner()?.name ?? "Selected runner"}
      />
    </div>
  );
}
