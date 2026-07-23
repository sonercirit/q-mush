import { type JSX } from "solid-js";
import {
  AGENT_SESSION_TOOL_NAMES,
  AGENT_SESSION_TOOL_OPTIONS,
  SESSION_AGENT_TOOL_NAMES,
  type AgentSessionToolName,
  type AgentSessionToolOption,
} from "../shared/agent-tools.ts";

export function SessionToolPicker(props: {
  readonly disabled: boolean;
  readonly onChange: (tools: readonly AgentSessionToolName[]) => void;
  readonly tools: readonly AgentSessionToolName[];
}): JSX.Element {
  const isSelected = (name: AgentSessionToolName): boolean =>
    props.tools.includes(name);
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
    <label class="flex items-start gap-3 rounded-xl border border-white/10 bg-slate-900 p-3 text-sm text-slate-300">
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
          {option.kind === "skill" ? "Skill" : "Tool"} · {option.description}
        </span>
      </span>
    </label>
  );

  return (
    <fieldset class="lg:col-span-2">
      <legend class="text-sm font-medium text-slate-200">
        Tools &amp; skills
      </legend>
      <p class="mt-1 text-xs leading-5 text-slate-500">
        Choose what the agent may use in this session. You can run a session
        with none selected.
      </p>
      <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {otherOptions.map(optionControl)}
      </div>
      <section class="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] p-3 lg:col-span-3">
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
        <div class="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sessionOptions.map(optionControl)}
        </div>
      </section>
    </fieldset>
  );
}
