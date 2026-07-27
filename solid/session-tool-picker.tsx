import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import {
  AGENT_SESSION_TOOL_NAMES,
  AGENT_SESSION_TOOL_OPTIONS,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
  type AgentSessionToolOption,
} from "../shared/agent-tools.ts";
import { ToolParameterDetails } from "./tool-parameter-details.tsx";

const CLASSIFICATION_LABELS = {
  runner_tool: "Runner tool",
  session_tool: "Session tool",
  skill: "Skill",
} as const;

function ToolDetailsPanel(props: {
  readonly option: AgentSessionToolOption;
}): JSX.Element {
  return (
    <aside
      aria-label={`Details for ${props.option.name}`}
      aria-live="polite"
      class="absolute top-full right-0 z-30 mt-2 max-h-[min(70vh,36rem)] w-full max-w-md min-w-0 overflow-y-auto overscroll-contain rounded-2xl border border-white/15 bg-slate-950 p-4 text-left shadow-2xl shadow-black/40 sm:min-w-80"
      data-tool-detail-panel={props.option.name}
      id={`tool-details-${props.option.name}`}
    >
      <div class="flex flex-wrap items-center gap-2">
        <code class="break-all text-sm font-semibold text-cyan-200">
          {props.option.definition.name}
        </code>
        <span class="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[0.65rem] font-semibold tracking-wide text-slate-400 uppercase">
          {CLASSIFICATION_LABELS[props.option.classification]}
        </span>
      </div>
      <p class="mt-3 text-xs leading-5 text-slate-300">
        {props.option.definition.description}
      </p>
      <h4 class="mt-4 mb-2 text-[0.7rem] font-semibold tracking-wide text-slate-400 uppercase">
        Parameters
      </h4>
      <ToolParameterDetails parameters={props.option.definition.parameters} />
    </aside>
  );
}

export function SessionToolPicker(props: {
  readonly disabled: boolean;
  readonly onChange: (tools: readonly AgentSessionToolName[]) => void;
  readonly tools: readonly AgentSessionToolName[];
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(true);
  const [openDetails, setOpenDetails] = createSignal<
    AgentSessionToolName | undefined
  >();
  let picker: HTMLFieldSetElement | undefined;
  const isSelected = (name: AgentSessionToolName): boolean =>
    props.tools.includes(name);
  const detailsButton = (
    name: AgentSessionToolName,
  ): HTMLButtonElement | undefined =>
    picker?.querySelector<HTMLButtonElement>(
      `button[data-tool-details='${name}']`,
    ) ?? undefined;
  const closeDetails = (restoreFocus = false): void => {
    const previous = openDetails();
    setOpenDetails(undefined);
    if (restoreFocus && previous !== undefined) {
      queueMicrotask(() => {
        detailsButton(previous)?.focus();
      });
    }
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && openDetails() !== undefined) {
      event.preventDefault();
      closeDetails(true);
    }
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (openDetails() === undefined) {
      return;
    }
    const target = event.target;
    const openName = openDetails();
    const panel =
      openName === undefined
        ? undefined
        : picker?.querySelector(`[data-tool-detail-panel='${openName}']`);
    const button = openName === undefined ? undefined : detailsButton(openName);
    if (
      (!(target instanceof Node) || panel?.contains(target) !== true) &&
      (!(target instanceof Node) || button?.contains(target) !== true)
    ) {
      closeDetails();
    }
  };
  createEffect(() => {
    window.addEventListener("keydown", onDocumentKeyDown);
    window.addEventListener("pointerdown", onDocumentPointerDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onDocumentKeyDown);
      window.removeEventListener("pointerdown", onDocumentPointerDown);
    });
  });

  const toggle = (name: AgentSessionToolName, enabled: boolean): void => {
    props.onChange(
      enabled
        ? AGENT_SESSION_TOOL_NAMES.filter(
            (toolName) => toolName === name || isSelected(toolName),
          )
        : props.tools.filter((toolName) => toolName !== name),
    );
  };
  const toggleGroup = (
    names: readonly AgentSessionToolName[],
    enabled: boolean,
  ): void => {
    props.onChange(
      enabled
        ? AGENT_SESSION_TOOL_NAMES.filter(
            (name) => names.includes(name) || isSelected(name),
          )
        : props.tools.filter((name) => !names.includes(name)),
    );
  };
  const sessionOptions = AGENT_SESSION_TOOL_OPTIONS.filter(({ name }) =>
    SESSION_AGENT_TOOL_NAMES.includes(name),
  );
  const otherOptions = AGENT_SESSION_TOOL_OPTIONS.filter(
    ({ name }) => !SESSION_AGENT_TOOL_NAMES.includes(name),
  );
  const optionControl = (option: AgentSessionToolOption): JSX.Element => (
    <div class="relative min-w-0 rounded-xl border border-white/10 bg-slate-900 p-3 text-sm text-slate-300">
      <div class="flex min-w-0 items-start gap-2">
        <label class="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
          <input
            checked={isSelected(option.name)}
            disabled={props.disabled}
            name="tools"
            onChange={(event) => {
              toggle(option.name, event.currentTarget.checked);
            }}
            type="checkbox"
            value={option.name}
          />
          <span class="min-w-0">
            <span class="block font-medium text-slate-200">{option.label}</span>
            <span class="mt-1 block text-xs leading-5 text-slate-500">
              {CLASSIFICATION_LABELS[option.classification]} ·{" "}
              {option.description}
            </span>
          </span>
        </label>
        <button
          aria-controls={`tool-details-${option.name}`}
          aria-expanded={openDetails() === option.name}
          aria-label={`Details for ${option.name}`}
          class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 text-base font-semibold text-slate-400 transition hover:border-cyan-300/30 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          data-tool-details={option.name}
          onClick={() => {
            setOpenDetails((current) =>
              current === option.name ? undefined : option.name,
            );
          }}
          type="button"
        >
          <span aria-hidden="true">i</span>
        </button>
      </div>
      <Show when={openDetails() === option.name}>
        <ToolDetailsPanel option={option} />
      </Show>
    </div>
  );

  return (
    <fieldset
      class="min-w-0 md:col-span-2"
      ref={(element) => {
        picker = element;
      }}
    >
      <legend class="text-sm font-medium text-slate-200">
        <span>Tools &amp; skills</span>
        <button
          aria-expanded={expanded()}
          class="ml-3 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
          data-tool-picker-toggle="true"
          onClick={() => {
            if (expanded()) closeDetails();
            setExpanded((current) => !current);
          }}
          type="button"
        >
          {expanded() ? "Collapse tools" : "Expand tools"}
        </button>
      </legend>
      <Show when={expanded()}>
        <div data-tool-picker-controls="true">
          <p class="mt-1 text-xs leading-5 text-slate-500">
            Choose what the agent may use in this session. You can run a session
            with none selected. Use each info button to inspect its
            authoritative schema.
          </p>
          <div class="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <For each={otherOptions}>{optionControl}</For>
          </div>
          <section class="mt-4 min-w-0 rounded-2xl border border-white/10 bg-white/[0.03] p-3 md:col-span-2">
            <label class="flex items-center gap-3 text-sm font-semibold text-slate-200">
              <input
                checked={SESSION_AGENT_TOOL_NAMES.every(isSelected)}
                disabled={props.disabled}
                name="session-tools"
                onChange={(event) => {
                  toggleGroup(
                    SESSION_AGENT_TOOL_NAMES,
                    event.currentTarget.checked,
                  );
                }}
                type="checkbox"
              />
              Session tools
            </label>
            <p class="mt-1 text-xs leading-5 text-slate-500">
              Toggle all tools for creating and controlling agent sessions.
            </p>
            <div class="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              <For each={sessionOptions}>{optionControl}</For>
            </div>
          </section>
        </div>
      </Show>
    </fieldset>
  );
}
