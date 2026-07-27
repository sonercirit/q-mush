import type { RunnerRestartState } from "./realtime-runner-runtime.ts";
import type { RealtimeRegistrationDependencies } from "./realtime-runner-types.ts";

export interface RunnerAdmissionContext {
  readonly options: RealtimeRegistrationDependencies;
  readonly runnerRestarts: ReadonlyMap<string, RunnerRestartState>;
}
