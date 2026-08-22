import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionRuntimes } from "./session-runtime.ts";

export interface SessionGenerationInterruptionDependencies {
  readonly broker: Pick<RunnerCommandBroker, "cancelSessionGeneration">;
  readonly now: () => number;
  readonly runtimes: Pick<SessionRuntimes, "abortForGeneration">;
}
