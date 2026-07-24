import { For, type JSX } from "solid-js";
import {
  type SessionTranscriptFilterName,
  type SessionTranscriptFilters,
} from "./session-transcript-filters.ts";

interface TranscriptFilterOption {
  readonly description: string;
  readonly label: string;
  readonly name: SessionTranscriptFilterName;
}

const TRANSCRIPT_FILTER_OPTIONS: readonly TranscriptFilterOption[] = [
  {
    description: "The Q Mush base instructions used for every session.",
    label: "Base instructions",
    name: "systemPrompt",
  },
  {
    description:
      "The stored AGENTS.md or CLAUDE.md instructions loaded for this session.",
    label: "Stored agent instructions",
    name: "agentInstructions",
  },
  {
    description:
      "The authoritative schemas and descriptions for tools selected on this session.",
    label: "Selected tool definitions",
    name: "toolDefinitions",
  },
  {
    description:
      "Historical assistant tool requests together with their matching results.",
    label: "Tool calls and responses",
    name: "toolActivity",
  },
  {
    description: "Instructions and follow-up messages sent by you.",
    label: "User messages",
    name: "userMessages",
  },
  {
    description: "Persisted and currently streaming model reasoning summaries.",
    label: "Thinking and reasoning",
    name: "thinking",
  },
  {
    description: "Model responses that are not tool calls.",
    label: "Assistant messages",
    name: "assistantMessages",
  },
  {
    description:
      "Persisted failures and other session-level transcript notices.",
    label: "Errors and session notices",
    name: "notices",
  },
];

export function SessionTranscriptFilterControls(props: {
  readonly counts: Readonly<Record<SessionTranscriptFilterName, number>>;
  readonly filters: SessionTranscriptFilters;
  readonly onChange: (
    name: SessionTranscriptFilterName,
    visible: boolean,
  ) => void;
}): JSX.Element {
  return (
    <details class="mt-4 rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2">
      <summary class="cursor-pointer select-none text-sm font-semibold text-slate-200 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300">
        Transcript visibility
        <span class="ml-2 font-normal text-slate-500">
          {`${String(
            TRANSCRIPT_FILTER_OPTIONS.filter(({ name }) => props.filters[name])
              .length,
          )}/${String(TRANSCRIPT_FILTER_OPTIONS.length)} shown`}
        </span>
      </summary>
      <fieldset
        aria-label="Transcript visibility"
        class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"
      >
        <legend class="sr-only">Visible transcript categories</legend>
        <For each={TRANSCRIPT_FILTER_OPTIONS}>
          {(option) => (
            <label class="flex items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5 text-sm text-slate-300">
              <input
                checked={props.filters[option.name]}
                class="mt-0.5"
                data-transcript-filter={option.name}
                onChange={(event) => {
                  props.onChange(option.name, event.currentTarget.checked);
                }}
                type="checkbox"
              />
              <span class="min-w-0">
                <span class="block font-medium text-slate-200">
                  {`${option.label} (${String(props.counts[option.name])})`}
                </span>
                <span class="mt-0.5 block text-xs leading-5 text-slate-500">
                  {option.description}
                </span>
              </span>
            </label>
          )}
        </For>
      </fieldset>
    </details>
  );
}
