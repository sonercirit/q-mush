import type { RunnerSummary } from "../shared/runner-model.ts";
import type { CustomSelectOption } from "./custom-select.tsx";
import type { SessionViewState } from "./session-client.tsx";
import type { SessionController } from "./session-controller.ts";

export interface SessionReassignmentDraft {
  readonly runnerId: string;
  readonly workingDirectory: string;
}

export function emptySessionReassignmentDraft(): SessionReassignmentDraft {
  return { runnerId: "", workingDirectory: "" };
}

export function hasTrimmedText(value: string): boolean {
  return value.trim().length > 0;
}

export interface SessionReassignmentViewProps {
  readonly controller: SessionController;
  readonly onOpenDirectoryPicker: () => void;
  readonly runners: readonly RunnerSummary[];
  readonly state: SessionViewState;
}

export function runnerIds(
  runners: readonly RunnerSummary[],
): readonly string[] {
  return runners.map((runner) => runner.id);
}

export function runnerSelectOptions(
  runners: readonly RunnerSummary[],
): readonly CustomSelectOption[] {
  return runners.map((runner) => ({
    label: runner.name ?? "Online runner",
    value: runner.id,
  }));
}
