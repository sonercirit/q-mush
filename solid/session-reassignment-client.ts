import type { RunnerSummary } from "../shared/runner-model.ts";
import type { CustomSelectOption } from "./custom-select.tsx";
import type { SessionRunnerViewProps } from "./session-runner-view-props.ts";

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

export type SessionReassignmentViewProps = SessionRunnerViewProps;

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
