import type { JSX } from "solid-js";
import type { RunnerSummary } from "../shared/runner-model.ts";
import { DirectoryPicker } from "./directory-picker-client.tsx";
import type { DirectoryPickerController } from "./directory-picker-controller.ts";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";

function controlAttributes(disabled: boolean) {
  return {
    className:
      "mt-2 min-w-0 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none",
    disabled,
    id: "session-directory",
    name: "workingDirectory",
    required: true,
  };
}

export function SessionDirectoryInput(props: {
  readonly controller: SessionController;
  readonly runnerAvailable: boolean;
  readonly state: SessionViewState;
}): JSX.Element {
  return (
    <div>
      <label class="text-sm font-medium text-slate-200" for="session-directory">
        Working directory on runner
      </label>
      <div class="flex items-center gap-2">
        <input
          {...controlAttributes(props.state.creating)}
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
        <button
          class="mt-2 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={props.state.creating || !props.runnerAvailable}
          onClick={() => {
            props.controller.openDirectoryPicker();
          }}
          type="button"
        >
          Browse
        </button>
      </div>
    </div>
  );
}

export function SessionDirectoryPicker(props: {
  readonly controller: DirectoryPickerController;
  readonly onChoose: () => void;
  readonly runners: readonly RunnerSummary[];
}): JSX.Element {
  const selectedRunner = (): RunnerSummary | undefined =>
    props.runners.find(({ id }) => id === props.controller.state.runnerId);
  return (
    <DirectoryPicker
      controller={props.controller}
      onChoose={props.onChoose}
      runnerName={selectedRunner()?.name ?? "Selected runner"}
    />
  );
}
