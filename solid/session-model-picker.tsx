import { createSignal, Show } from "solid-js";
import type { AgentModelCatalog } from "../shared/agent-configuration.ts";
import type { AgentSessionSummary } from "../shared/session-model.ts";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import {
  selectedSessionCredentialOption,
  type SessionCredentialOption,
} from "./session-credential-option.ts";
import {
  createSessionEditorRequestState,
  type SessionEditorRequestState,
} from "./session-editor-client.tsx";
import {
  modelCatalogOptions,
  modelCredentialValue,
  reasoningModelOptions,
  type SessionModelDiscoverer,
} from "./session-model-options.ts";

export interface SessionModelPickerSelection {
  readonly credential: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

interface SessionModelPickerFieldsProps {
  readonly catalog: AgentModelCatalog | undefined;
  readonly credentialEmptyLabel: string;
  readonly credentialOptions: readonly CustomSelectOption[];
  readonly disabled: boolean;
  readonly hideReasoning?: boolean;
  readonly idPrefix: string;
  readonly namePrefix: string;
  readonly onChooseCredential: (value: string) => void;
  readonly onChooseModel: (value: string) => void;
  readonly onChooseReasoning: (value: string) => void;
  readonly onToggle: (name: "credential" | "model" | "reasoning") => void;
  readonly open: "credential" | "model" | "reasoning" | undefined;
  readonly selection: SessionModelPickerSelection;
}

export function initialSessionModelPickerSelection(
  detail: Pick<
    AgentSessionSummary,
    "credentialId" | "model" | "provider" | "reasoningEffort"
  >,
): SessionModelPickerSelection {
  return {
    credential: sessionCredentialValueFromDetail(detail),
    model: detail.model,
    reasoningEffort: detail.reasoningEffort ?? "",
  };
}

function sessionCredentialValueFromDetail(
  detail: Pick<AgentSessionSummary, "credentialId" | "provider">,
): string {
  return modelCredentialValue({
    credentialId: detail.credentialId,
    provider: detail.provider,
  });
}

function discoveredSessionModelSelection(
  catalog: AgentModelCatalog,
  current: Pick<SessionModelPickerSelection, "model" | "reasoningEffort">,
): Pick<SessionModelPickerSelection, "model" | "reasoningEffort"> {
  const selected = catalog.models.find(({ id }) => id === current.model);
  const model = selected?.id ?? catalog.models[0]?.id ?? "";
  return {
    model,
    reasoningEffort:
      selected?.reasoningEfforts.some(
        (effort) => effort === current.reasoningEffort,
      ) === true
        ? current.reasoningEffort
        : "",
  };
}

interface SessionModelEditorActions {
  readonly choose: {
    readonly credential: (credential: string) => void;
    readonly model: (model: string) => void;
    readonly reasoning: (reasoningEffort: string) => void;
  };
}

export interface SessionModelEditor extends SessionModelDiscoveryState {
  readonly actions: SessionModelEditorActions;
  readonly patch: (values: Partial<SessionModelPickerSelection>) => void;
}

export function createSessionModelPickerState<
  Selection extends SessionModelPickerSelection,
  Open extends string = "credential" | "model" | "reasoning",
>(initial: Selection, props: SessionModelPickerSelectionProps) {
  const [draft, setDraft] = createSignal(initial);
  const [open, setOpen] = createSignal<Open>();
  const request = createSessionEditorRequestState();
  return {
    draft,
    editor: createSessionModelEditorFromProps(
      props,
      draft,
      setDraft,
      setOpen,
      request,
    ),
    open,
    request,
    setDraft,
    setOpen,
  };
}

function createSessionModelEditorFromProps(
  props: SessionModelPickerSelectionProps,
  current: () => SessionModelPickerSelection,
  setCurrent: (
    update: (
      current: SessionModelPickerSelection,
    ) => SessionModelPickerSelection,
  ) => SessionModelPickerSelection,
  setOpen: (value: undefined) => void,
  request: Pick<SessionEditorRequestState, "latest" | "setError">,
): SessionModelEditor {
  return createSessionModelEditor({
    get credentials() {
      return props.credentials;
    },
    current,
    onDiscoverModels: props.onDiscoverModels,
    request,
    setCurrent,
    setOpen,
  });
}

function createSessionModelEditor<
  Selection extends SessionModelPickerSelection,
>(
  options: SessionModelPickerSelectionProps & {
    readonly current: () => Selection;
    readonly request: Pick<SessionEditorRequestState, "latest" | "setError">;
    readonly setCurrent: (
      update: (current: Selection) => Selection,
    ) => Selection;
    readonly setOpen: (value: undefined) => void;
  },
): SessionModelEditor {
  const patch = (values: Partial<SessionModelPickerSelection>): void => {
    options.setCurrent((current) => ({ ...current, ...values }));
  };
  const discovery = createSessionModelDiscovery({
    get credentials() {
      return options.credentials;
    },
    current: options.current,
    onDiscoverModels: options.onDiscoverModels,
    patch,
    request: options.request,
  });
  return {
    ...discovery,
    actions: createSessionModelEditorActions({
      discover: discovery.discover,
      patch,
      setOpen: options.setOpen,
    }),
    patch,
  };
}

function closeEditor(setOpen: (value: undefined) => void): void {
  setOpen(undefined);
}

function createSessionModelEditorActions(options: {
  readonly discover: (credential: string) => Promise<void>;
  readonly patch: (values: Partial<SessionModelPickerSelection>) => void;
  readonly setOpen: (value: undefined) => void;
}): SessionModelEditorActions {
  return {
    choose: {
      credential: (credential) => {
        closeEditor(options.setOpen);
        options.patch({ credential, model: "", reasoningEffort: "" });
        void options.discover(credential);
      },
      model: (model) => {
        options.patch({ model, reasoningEffort: "" });
        closeEditor(options.setOpen);
      },
      reasoning: (reasoningEffort) => {
        options.patch({ reasoningEffort });
        closeEditor(options.setOpen);
      },
    },
  };
}

export interface SessionModelPickerSelectionProps {
  readonly credentials: readonly SessionCredentialOption[];
  readonly onDiscoverModels: SessionModelDiscoverer;
}

interface SessionModelDiscoveryState {
  readonly catalog: () => AgentModelCatalog | undefined;
  readonly discover: (credentialValue: string) => Promise<void>;
}

function createSessionModelDiscovery(
  options: SessionModelPickerSelectionProps & {
    readonly current: () => SessionModelPickerSelection;
    readonly patch: (
      values: Pick<SessionModelPickerSelection, "model" | "reasoningEffort">,
    ) => void;
    readonly request: Pick<SessionEditorRequestState, "latest" | "setError">;
  },
): SessionModelDiscoveryState {
  const [catalog, setCatalog] = createSignal<AgentModelCatalog>();
  return {
    catalog,
    discover: async (credentialValue) => {
      const selected = selectedSessionCredentialOption(
        options.credentials,
        credentialValue,
      );
      if (selected === undefined) return;
      const currentRequest = options.request.latest.begin();
      options.request.setError(undefined);
      setCatalog(undefined);
      const models = await options.onDiscoverModels(
        selected.provider,
        selected.credential.id,
      );
      if (!options.request.latest.isLatest(currentRequest)) return;
      setCatalog(models);
      if (models === undefined) {
        options.request.setError("Models are unavailable for that credential.");
        return;
      }
      options.patch(discoveredSessionModelSelection(models, options.current()));
    },
  };
}

export function SessionModelPickerFields(props: SessionModelPickerFieldsProps) {
  const models = () => modelCatalogOptions(props.catalog);
  const selectedModel = () =>
    props.catalog?.models.find(({ id }) => id === props.selection.model);
  return (
    <>
      <CustomSelect
        disabled={props.disabled || props.credentialOptions.length === 0}
        emptyLabel={props.credentialEmptyLabel}
        id={`${props.idPrefix}-credential`}
        label="Model credential"
        name={`${props.namePrefix}Credential`}
        onChoose={props.onChooseCredential}
        onToggle={() => {
          props.onToggle("credential");
        }}
        open={props.open === "credential"}
        options={props.credentialOptions}
        required
        selectedValue={props.selection.credential}
      />
      <CustomSelect
        disabled={props.disabled || models().length === 0}
        emptyLabel="Models unavailable"
        id={`${props.idPrefix}-model`}
        label="Model"
        name={`${props.namePrefix}Model`}
        onChoose={props.onChooseModel}
        onToggle={() => {
          props.onToggle("model");
        }}
        open={props.open === "model"}
        options={models()}
        required
        selectedValue={props.selection.model}
      />
      <Show when={props.hideReasoning !== true}>
        <CustomSelect
          disabled={
            props.disabled ||
            (selectedModel()?.reasoningEfforts.length ?? 0) === 0
          }
          emptyLabel="Model default"
          id={`${props.idPrefix}-reasoning`}
          label="Reasoning effort"
          name={`${props.namePrefix}ReasoningEffort`}
          onChoose={props.onChooseReasoning}
          onToggle={() => {
            props.onToggle("reasoning");
          }}
          open={props.open === "reasoning"}
          options={reasoningModelOptions(props.catalog, props.selection.model)}
          required={false}
          selectedValue={props.selection.reasoningEffort}
        />
      </Show>
    </>
  );
}
