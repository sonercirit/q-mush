import {
  createEffect,
  createSignal,
  on,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import {
  MAXIMUM_TOOL_EXECUTION_MINUTES,
  MAXIMUM_TOOL_OUTPUT_CHARACTERS,
  MINIMUM_TOOL_OUTPUT_CHARACTERS,
  type ToolSettings,
} from "../shared/tool-limits.ts";
import { renderFormField } from "./form-field.tsx";
import type { ToolSettingsController } from "./tool-settings-controller.ts";

function integerInput(
  value: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function ToolSettingsPanel(props: {
  readonly controller: ToolSettingsController;
}): JSX.Element {
  const [execution, setExecution] = createSignal("");
  const [output, setOutput] = createSignal("");
  const state = () => props.controller.view();
  let synchronized: ToolSettings | undefined;
  createEffect(
    on(
      () => state().settings,
      (settings) => {
        if (settings === undefined) {
          synchronized = undefined;
          setExecution("");
          setOutput("");
          return;
        }
        const previous = synchronized;
        const pristine =
          previous === undefined ||
          (untrack(execution) === String(previous.executionLimitMinutes) &&
            untrack(output) === String(previous.outputLimitCharacters));
        synchronized = settings;
        if (pristine) {
          setExecution(String(settings.executionLimitMinutes));
          setOutput(String(settings.outputLimitCharacters));
        }
      },
    ),
  );
  const save = (): void => {
    const executionLimitMinutes = integerInput(
      execution(),
      1,
      MAXIMUM_TOOL_EXECUTION_MINUTES,
    );
    const outputLimitCharacters = integerInput(
      output(),
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
      MAXIMUM_TOOL_OUTPUT_CHARACTERS,
    );
    if (
      executionLimitMinutes === undefined ||
      outputLimitCharacters === undefined
    ) {
      return;
    }
    void props.controller.save({
      executionLimitMinutes,
      outputLimitCharacters,
    } satisfies ToolSettings);
  };
  const valid = () =>
    integerInput(execution(), 1, MAXIMUM_TOOL_EXECUTION_MINUTES) !==
      undefined &&
    integerInput(
      output(),
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
      MAXIMUM_TOOL_OUTPUT_CHARACTERS,
    ) !== undefined;

  const input = (
    id: string,
    label: string,
    maximum: number,
    minimum: number,
    name: string,
    value: () => string,
    update: (next: string) => void,
  ): JSX.Element =>
    renderFormField(
      id,
      label,
      <input
        class="mt-2 w-full rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2 text-white"
        disabled={state().loading || state().saving}
        id={id}
        max={maximum}
        min={minimum}
        name={name}
        onInput={(event) => {
          update(event.currentTarget.value);
        }}
        required
        type="number"
        value={value()}
      />,
    );

  return (
    <section
      aria-labelledby="tool-settings-title"
      class="rounded-3xl border border-white/10 bg-slate-900/80 p-4 sm:p-6 lg:p-8"
      data-tool-settings="global"
    >
      <h2 class="text-2xl font-semibold text-white" id="tool-settings-title">
        Global tool limits
      </h2>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
        These per-user limits apply to every session when its next run starts.
        Active runs keep the snapshot shown to their model until that run ends.
        Output characters are Unicode code points.
      </p>
      <div class="mt-5 grid gap-4 sm:grid-cols-2">
        {input(
          "tool-execution-limit",
          "Execution limit (minutes)",
          MAXIMUM_TOOL_EXECUTION_MINUTES,
          1,
          "toolExecutionLimitMinutes",
          execution,
          setExecution,
        )}
        {input(
          "tool-output-limit",
          "Model-facing output limit (characters)",
          MAXIMUM_TOOL_OUTPUT_CHARACTERS,
          MINIMUM_TOOL_OUTPUT_CHARACTERS,
          "toolOutputLimitCharacters",
          output,
          setOutput,
        )}
      </div>
      <div class="mt-5 flex flex-wrap items-center gap-3">
        <button
          class="rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          disabled={state().loading || state().saving || !valid()}
          onClick={save}
          type="button"
        >
          {state().saving ? "Saving…" : "Save tool limits"}
        </button>
        <Show when={state().error}>
          {(error) => (
            <span class="text-sm text-rose-200" role="alert">
              {error()}
            </span>
          )}
        </Show>
      </div>
    </section>
  );
}
