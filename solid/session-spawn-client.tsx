import { createEffect, untrack, type JSX } from "solid-js";

import type { RunnerSummary } from "../shared/runner-model.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { CustomSelect, type CustomSelectOption } from "./custom-select.tsx";
import type { UserSpawnSessionSelection } from "./session-controller-spawn.ts";
import {
  selectedSessionCredentialOption,
  sessionCredentialSelectOptions,
} from "./session-credential-option.ts";
import {
  SessionEditorError,
  SessionEditorSection,
} from "./session-editor-client.tsx";
import {
  createSessionModelPickerState,
  SessionModelPickerFields,
  type SessionModelPickerSelectionProps,
} from "./session-model-picker.tsx";
import { SessionToolPicker } from "./session-tool-picker.tsx";
import type { SessionDraft } from "./session-view-state.ts";

type SpawnDraft = Omit<SessionDraft, "images" | "openRouterProviderTag">;

type SpawnSelect =
  "credential" | "environment" | "model" | "reasoning" | "runner";

function initialDraft(detail: AgentSessionDetail): SpawnDraft {
  return {
    autoCompact: detail.autoCompact,
    credential: `${detail.provider}:${detail.credentialId}`,
    executionEnvironment: detail.executionEnvironment,
    model: detail.model,
    prompt: "",
    reasoningEffort: detail.reasoningEffort ?? "",
    runnerId: detail.runnerId,
    tools: detail.tools,
    workingDirectory: detail.workingDirectory,
  };
}

function options(values: readonly (readonly [string, string])[]) {
  return values.map(([value, label]) => ({ label, value }));
}

interface SpawnEditorProps extends SessionModelPickerSelectionProps {
  readonly detail: AgentSessionDetail;
  readonly onSpawn: (selection: UserSpawnSessionSelection) => Promise<void>;
  readonly runners: readonly RunnerSummary[];
}

function selectOptions(props: SpawnEditorProps) {
  return {
    credentials: (): readonly CustomSelectOption[] =>
      sessionCredentialSelectOptions(props.credentials),
    runners: (): readonly CustomSelectOption[] =>
      props.runners.map((runner) => ({
        label: runner.name ?? runner.id,
        value: runner.id,
      })),
  };
}

function spawnSelection(
  props: SpawnEditorProps,
  draft: SpawnDraft,
): UserSpawnSessionSelection | undefined {
  const selected = selectedSessionCredentialOption(
    props.credentials,
    draft.credential,
  );
  if (
    selected === undefined ||
    draft.runnerId.length === 0 ||
    draft.model.length === 0 ||
    draft.prompt.trim().length === 0 ||
    draft.workingDirectory.trim().length === 0
  ) {
    return undefined;
  }
  return {
    autoCompact: draft.autoCompact,
    credentialId: selected.credential.id,
    executionEnvironment: draft.executionEnvironment,
    model: draft.model,
    parentGeneration: props.detail.generation,
    parentSessionId: props.detail.id,
    prompt: draft.prompt.trim(),
    provider: selected.provider,
    ...(draft.reasoningEffort.length === 0
      ? {}
      : { reasoningEffort: draft.reasoningEffort }),
    runnerId: draft.runnerId,
    tools: draft.tools,
    workingDirectory: draft.workingDirectory.trim(),
  };
}

export function SessionSpawnEditor(props: SpawnEditorProps): JSX.Element {
  const initial = untrack(() => initialDraft(props.detail));
  const modelState = createSessionModelPickerState<SpawnDraft, SpawnSelect>(
    initial,
    props,
  );
  const { draft, editor, open, request, setDraft, setOpen } = modelState;
  const error = request.error;
  const pending = request.pending;
  const setError = request.setError;
  const setPending = request.setPending;
  let discoveredSelection: SpawnDraft | undefined;
  const available = selectOptions(props);
  const discover = editor.discover;
  const toggle = (name: SpawnSelect): void => {
    setOpen(open() === name ? undefined : name);
  };
  const modelPickerOpen = () => {
    const selected = open();
    return selected === "credential" ||
      selected === "model" ||
      selected === "reasoning"
      ? selected
      : undefined;
  };
  createEffect(() => {
    const initial = initialDraft(props.detail);
    if (
      initial.credential === discoveredSelection?.credential &&
      initial.model === discoveredSelection.model
    ) {
      return;
    }
    discoveredSelection = initial;
    setDraft(initial);
    setError(undefined);
    void discover(initial.credential);
  });
  const patch = (values: Partial<SpawnDraft>): void => {
    setDraft((current) => ({ ...current, ...values }));
  };
  const chooseCredential = editor.actions.choose.credential;
  const submit = async (): Promise<void> => {
    const selection = spawnSelection(props, draft());
    if (selection === undefined) {
      setError(
        "Choose a runner, credential, and model, then describe the child task.",
      );
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await props.onSpawn(selection);
      patch({ prompt: "" });
    } catch {
      setError("We could not spawn that child session. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <SessionEditorSection
      description={
        <>
          Start a child whose completion is reported back to this session. You
          decide exactly which tools and skills it receives.
        </>
      }
      kind="spawn"
      title="Spawn child session"
    >
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <CustomSelect
          disabled={pending()}
          emptyLabel="No online runners"
          id="spawn-runner"
          label="Runner"
          name="spawnRunner"
          onChoose={(runnerId) => {
            patch({ runnerId });
            setOpen(undefined);
          }}
          onToggle={() => {
            toggle("runner");
          }}
          open={open() === "runner"}
          options={available.runners()}
          required
          selectedValue={draft().runnerId}
        />
        <SessionModelPickerFields
          catalog={editor.catalog()}
          credentialEmptyLabel="No model credentials"
          credentialOptions={available.credentials()}
          disabled={pending()}
          idPrefix="spawn"
          namePrefix="spawn"
          onChooseCredential={chooseCredential}
          onChooseModel={editor.actions.choose.model}
          onChooseReasoning={editor.actions.choose.reasoning}
          onToggle={(name) => {
            toggle(name);
          }}
          open={modelPickerOpen()}
          selection={draft()}
        />
        <div>
          <label
            class="text-sm font-medium text-slate-200"
            for="spawn-directory"
          >
            Working directory on runner
          </label>
          <input
            class="mt-2 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white"
            disabled={pending()}
            id="spawn-directory"
            name="spawnWorkingDirectory"
            onInput={(event) => {
              patch({ workingDirectory: event.currentTarget.value });
            }}
            required
            type="text"
            value={draft().workingDirectory}
          />
        </div>
        <CustomSelect
          disabled={pending()}
          emptyLabel="Bare Metal"
          id="spawn-environment"
          label="Execution environment"
          name="spawnExecutionEnvironment"
          onChoose={(executionEnvironment) => {
            patch({
              executionEnvironment:
                executionEnvironment === "container"
                  ? "container"
                  : "bare_metal",
            });
            setOpen(undefined);
          }}
          onToggle={() => {
            toggle("environment");
          }}
          open={open() === "environment"}
          options={options([
            ["bare_metal", "Bare Metal"],
            ["container", "Container"],
          ])}
          required
          selectedValue={draft().executionEnvironment}
        />
        <label class="flex items-center gap-2 text-sm text-slate-300 sm:col-span-2">
          <input
            checked={draft().autoCompact}
            disabled={pending()}
            onChange={(event) => {
              patch({ autoCompact: event.currentTarget.checked });
            }}
            type="checkbox"
          />
          Compact automatically near the context limit
        </label>
        <SessionToolPicker
          disabled={pending()}
          onChange={(tools) => {
            patch({ tools });
          }}
          tools={draft().tools}
        />
        <div class="sm:col-span-2">
          <label class="text-sm font-medium text-slate-200" for="spawn-prompt">
            Child task
          </label>
          <textarea
            class="mt-2 min-h-28 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white"
            disabled={pending()}
            id="spawn-prompt"
            name="spawnPrompt"
            onInput={(event) => {
              patch({ prompt: event.currentTarget.value });
            }}
            value={draft().prompt}
          />
        </div>
      </div>
      <SessionEditorError message={error()} />
      <button
        class="mt-4 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50"
        data-session-spawn-submit="true"
        disabled={pending()}
        onClick={() => void submit()}
        type="button"
      >
        {pending() ? "Spawning…" : "Spawn child"}
      </button>
    </SessionEditorSection>
  );
}
