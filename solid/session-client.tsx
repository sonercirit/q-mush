import {
  createEffect,
  createMemo,
  createSignal,
  onMount,
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
import { DirectoryPicker } from "./directory-picker-client.tsx";
import { renderFormField } from "./form-field.tsx";
import { findById } from "./id-selection.ts";
import {
  modelModalitiesLabel,
  renderModelModalities,
} from "./model-modalities-client.tsx";
import type { ProviderViewState } from "./provider-credential-model.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import type { RunnerViewState } from "./runner-client.tsx";
import {
  SessionDraftEchoInput,
  SessionPromptInput,
} from "./session-client-forms.tsx";
import { SessionDraftCompactionToggles } from "./session-compaction-toggle.tsx";
import { formatTokenCount } from "./session-context-client.tsx";
import { SessionContextTokenCapInput } from "./session-context-token-cap-input.tsx";
import type { SessionController } from "./session-controller.ts";
import { credentialOptions } from "./session-credential-list.ts";
import {
  selectedSessionCredential,
  sessionCredentialSelectOptions,
  type SessionCredentialOption,
} from "./session-credential-option.ts";
import { SessionDirectoryInput } from "./session-directory-input.tsx";
import { SessionExecutionEnvironmentSelect } from "./session-execution-environment.tsx";
import { SessionResults } from "./session-focus-client.tsx";
import {
  retainNewSessionFormState,
  type NewSessionFormState,
} from "./session-new-form-state.ts";
import {
  defaultModelCredentialValue,
  defaultOnlineRunnerId,
  selectedOptionValue,
  selectedSessionCredentialOption,
} from "./session-new-selection.ts";
import type { SessionPanelResources } from "./session-panel-resources.ts";
import {
  createSessionShortcuts,
  sessionComposerShortcut,
  SessionShortcutHint,
} from "./session-pending-client.tsx";
import { OpenRouterProviderSelect } from "./session-provider-select.tsx";
import { runnerSelectOptions } from "./session-reassignment-client.ts";
import { selectedSessionCredentialAvailable } from "./session-resource-availability.ts";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";
import { SessionToolLimitsHeader } from "./session-tool-limits-note.tsx";
import { SessionToolPicker } from "./session-tool-picker.tsx";

export type {
  SessionDraft,
  SessionModelDiscoveryState,
  SessionViewState,
} from "./session-view-state.ts";

type CredentialOption = SessionCredentialOption;

const onlineRunners = (state: RunnerViewState): readonly RunnerSummary[] =>
  state.runners?.filter(({ status }) => status === "online") ?? [];

function providerIsLoading(state: ProviderViewState): boolean {
  return state.credentials === undefined && state.error === undefined;
}

function credentialFallbackReady(
  openAi: ProviderViewState,
  openRouter: ProviderViewState,
  generic?: ProviderViewState,
): boolean {
  return (
    !providerIsLoading(openAi) &&
    !providerIsLoading(openRouter) &&
    (generic === undefined || !providerIsLoading(generic))
  );
}

const selectValue = selectedOptionValue;
const defaultRunnerId = defaultOnlineRunnerId;
const defaultCredentialValue = defaultModelCredentialValue;
const selectedCredential = selectedSessionCredentialOption;

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

function retainedSelectionOptions(
  options: readonly CustomSelectOption[],
  selectedValue: string,
): readonly CustomSelectOption[] {
  return selectedValue.length === 0 ||
    options.some(({ value }) => value === selectedValue)
    ? options
    : [
        {
          label: `${selectedValue} (temporarily unavailable)`,
          value: selectedValue,
        },
        ...options,
      ];
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
  props: Omit<SessionRunnerViewProps, "state"> & {
    readonly credentials: readonly CredentialOption[];
    readonly credentialsSettled: boolean;
    readonly state: NewSessionFormState;
    readonly toolSettings?: SessionPanelResources["toolSettings"];
  },
): JSX.Element {
  const runners = createMemo(() => props.runners);
  const credentials = createMemo(() => props.credentials);
  const availableRunnerOptions = createMemo(() =>
    runnerSelectOptions(runners()),
  );
  const runnerOptions = createMemo(() =>
    retainedSelectionOptions(
      availableRunnerOptions(),
      props.state.draft.runnerId,
    ),
  );
  const selectedRunnerId = createMemo(() =>
    selectValue(
      runnerOptions(),
      props.state.draft.runnerId,
      defaultRunnerId(runners()),
    ),
  );
  const availableCredentialOptions = createMemo(() =>
    sessionCredentialSelectOptions(credentials()),
  );
  const credentialSelectOptions = createMemo(() =>
    retainedSelectionOptions(
      availableCredentialOptions(),
      props.state.draft.credential,
    ),
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
  const credentialSelection = createMemo(() =>
    selectedSessionCredential(selectedCredentialValue()),
  );
  const discovery = createMemo(() => {
    const value =
      credentialSelection() === undefined
        ? undefined
        : selectedCredentialValue();
    return props.state.modelDiscovery.credential === value
      ? props.state.modelDiscovery
      : undefined;
  });
  const models = createMemo(() => discovery()?.catalog?.models ?? []);
  const modelValue = createMemo(() =>
    props.state.draft.model.length > 0 || models().length === 0
      ? props.state.draft.model
      : (models()[0]?.id ?? ""),
  );
  const model = createMemo(() => findById(models(), modelValue()));
  const modelOptions = createMemo(() =>
    retainedSelectionOptions(modelSelectOptions(models()), modelValue()),
  );
  const reasoningOptions = createMemo(() =>
    retainedSelectionOptions(
      [
        { label: "Model default", value: "" },
        ...(model()?.reasoningEfforts ?? []).map((effort) => ({
          label: reasoningEffortLabel(effort),
          value: effort,
        })),
      ],
      props.state.draft.reasoningEffort,
    ),
  );
  const providerDiscoveryKey = createMemo(() =>
    credentialSelection()?.provider === "openrouter" && modelValue().length > 0
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
      runners().some(({ id }) => id === selectedRunnerId()) &&
      credential() !== undefined &&
      models().some(({ id }) => id === modelValue()),
  );
  const [shortcuts, setShortcutPlatform] = createSessionShortcuts();
  onMount(() => {
    setShortcutPlatform(navigator.platform);
  });

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
      <SessionDirectoryInput
        controller={props.controller}
        onOpenDirectoryPicker={props.onOpenDirectoryPicker}
        runnerAvailable={selectedRunnerId().length > 0}
        state={props.state}
      />
      {renderFormField(
        "session-agent-file-path",
        <>Agent file path (optional)</>,
        <SessionDraftEchoInput
          disabled={props.state.creating}
          id="session-agent-file-path"
          name="agentFilePath"
          onInput={(value) => {
            props.controller.setDraftField("agentFilePath", value);
          }}
          placeholder="AGENTS.md, config/instructions.md, or /absolute/path"
          value={props.state.draft.agentFilePath ?? ""}
        />,
      )}
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
            modelOptions().map(({ value }) => value),
          );
        }}
        onToggle={() => {
          toggleSelect("model");
        }}
        open={props.state.openSelect === "model"}
        options={modelOptions()}
        required
        selectedValue={modelValue()}
      />
      <Show
        when={
          credentialSelection()?.provider === "openrouter" &&
          modelValue().length > 0
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
          props.state.creating ||
          ((model()?.reasoningEfforts.length ?? 0) === 0 &&
            props.state.draft.reasoningEffort.length === 0)
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
        options={reasoningOptions()}
        required={false}
        selectedValue={props.state.draft.reasoningEffort}
      />
      {renderModelModalities(model())}
      <SessionContextTokenCapInput
        disabled={props.state.creating}
        model={model()}
        onInput={(value) => {
          props.controller.setDraftField("userContextTokenCap", value);
        }}
        value={props.state.draft.userContextTokenCap}
      />
      <SessionDraftCompactionToggles
        autoCompact={props.state.draft.autoCompact}
        disabled={props.state.creating}
        idleCompact={props.state.draft.idleCompact}
        onChange={props.controller.setDraftFlag}
      />
      <SessionToolPicker
        disabled={props.state.creating}
        onChange={(tools) => {
          props.controller.setTools(tools);
        }}
        settings={props.toolSettings?.()}
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
        onKeyDown={(event) => {
          if (
            !props.state.creating &&
            available() &&
            sessionComposerShortcut(event) === "steer"
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
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
          aria-keyshortcuts={shortcuts().steerKeys}
          class="shrink-0 rounded-xl bg-emerald-300 px-5 py-3 font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            props.state.creating ||
            !available() ||
            props.toolSettings?.() === undefined
          }
          title={`Start session (${shortcuts().steerLabel})`}
          type="submit"
        >
          <span>{props.state.creating ? "Starting…" : "Start session"}</span>
          <SessionShortcutHint label={shortcuts().steerLabel} />
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
  const newSessionState = createMemo<NewSessionFormState>((previous) =>
    retainNewSessionFormState(state(), previous),
  );
  const online = () => onlineRunners(props.runners());
  const providerStates = () =>
    [props.openAi(), props.openRouter(), props.generic?.()] as const;
  const credentials = () => credentialOptions(...providerStates());
  const credentialsSettled = () => credentialFallbackReady(...providerStates());
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
        <SessionToolLimitsHeader settings={() => props.toolSettings?.()} />
        <NewSessionForm
          controller={props.controller}
          credentials={credentials()}
          credentialsSettled={credentialsSettled()}
          onOpenDirectoryPicker={openDirectoryPicker}
          runners={online()}
          state={newSessionState()}
          toolSettings={props.toolSettings}
        />
        <ControllerRetryNotice
          error={state().error}
          load={props.controller.load.bind(props.controller)}
        />
        <SessionResults
          controller={props.controller}
          credentialAvailable={selectedSessionCredentialAvailable(
            state().detail,
            ...providerStates(),
          )}
          credentials={credentials()}
          focusMode={focusMode}
          onOpenDirectoryPicker={openDirectoryPicker}
          runners={online()}
          setFocusMode={setFocusMode}
          toolSettings={props.toolSettings?.()}
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
