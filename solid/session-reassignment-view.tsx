import { type JSX } from "solid-js";
import { CustomSelect } from "./custom-select.tsx";
import { DirectoryBrowseButton } from "./directory-browse-button.tsx";
import {
  hasTrimmedText,
  runnerIds,
  runnerSelectOptions,
  type SessionReassignmentViewProps,
} from "./session-reassignment-client.ts";

export function RunnerReassignment(
  props: SessionReassignmentViewProps,
): JSX.Element {
  const options = () => runnerSelectOptions(props.runners);
  const valid = () =>
    options().some(
      ({ value }) => value === props.state.reassignment.runnerId,
    ) && hasTrimmedText(props.state.reassignment.workingDirectory);

  return (
    <div
      class="mt-5 rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4"
      role="status"
    >
      <h4 class="font-semibold text-amber-100">Choose a replacement runner</h4>
      <p class="mt-2 text-sm leading-6 text-amber-100/80">
        The previous runner was removed. Select an online runner and confirm a
        working directory on that computer. Reassignment will not start work.
      </p>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <CustomSelect
          disabled={props.state.reassigning || options().length === 0}
          emptyLabel="No online runners"
          id="session-reassignment-runner"
          label="Replacement runner"
          name="reassignmentRunnerId"
          onChoose={(runnerId) => {
            props.controller.chooseReassignmentRunner(
              runnerId,
              runnerIds(props.runners),
            );
          }}
          onToggle={() => {
            props.controller.toggleReassignmentRunner();
          }}
          open={props.state.openSelect === "reassignmentRunnerId"}
          options={options()}
          required
          selectedValue={props.state.reassignment.runnerId}
        />
        <div>
          <label
            class="text-sm font-medium text-slate-200"
            for="session-reassignment-directory"
          >
            Working directory on replacement
          </label>
          <div class="flex items-center gap-2">
            <input
              class="mt-2 min-w-0 w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none"
              disabled={props.state.reassigning}
              id="session-reassignment-directory"
              onInput={(event) => {
                props.controller.setReassignmentDirectory(
                  event.currentTarget.value,
                );
              }}
              placeholder="Choose or enter a path"
              type="text"
              value={props.state.reassignment.workingDirectory}
            />
            <DirectoryBrowseButton
              class="mt-2 shrink-0 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 disabled:opacity-50"
              disabled={
                props.state.reassigning ||
                props.state.reassignment.runnerId.length === 0
              }
              onClick={props.onOpenDirectoryPicker}
            />
          </div>
        </div>
      </div>
      <button
        class="mt-4 rounded-xl bg-amber-200 px-4 py-2.5 text-sm font-semibold text-slate-950 disabled:opacity-50"
        disabled={props.state.reassigning || !valid()}
        onClick={() => {
          void props.controller.reassign(runnerIds(props.runners));
        }}
        type="button"
      >
        {props.state.reassigning ? "Reassigning…" : "Reassign"}
      </button>
    </div>
  );
}
