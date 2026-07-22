import type { RunnerSummary } from "../shared/runner-model.ts";
import type { RunnerSetupInstructions } from "./runner-client.tsx";

export function defaultedRunners(
  runners: readonly RunnerSummary[] | undefined,
  runnerId: string,
): readonly RunnerSummary[] | undefined {
  return runners?.map((runner) => ({
    ...runner,
    isDefault: runner.id === runnerId,
  }));
}

export function setupWithoutRunner(
  setup: RunnerSetupInstructions | undefined,
  runnerId: string,
): RunnerSetupInstructions | undefined {
  return setup?.runnerId === runnerId ? undefined : setup;
}
