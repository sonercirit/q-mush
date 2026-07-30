import type { JSX } from "solid-js";
import { DirectoryBrowseButton } from "./directory-browse-button.tsx";
import type { SessionController } from "./session-controller.ts";
import type { SessionViewState } from "./session-view-state.ts";

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

export function renderSessionField(
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

export function SessionDirectoryInput(props: {
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
