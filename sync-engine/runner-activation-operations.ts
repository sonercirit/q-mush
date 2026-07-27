import type {
  FinalizedRunnerActivationParameters,
  RunnerLifecycleParameters,
} from "./runner-registration-parameters.ts";
import type { RunnerConnection } from "./runner-registration-types.ts";

export interface RunnerActivationLifecycleOperations {
  settleActivationLifecycle(...parameters: RunnerLifecycleParameters): boolean;
}

export interface FinalizedRunnerActivationOperations<
  Result = RunnerConnection | undefined,
  AdditionalArguments extends readonly unknown[] = readonly [now: number],
> {
  touchFinalizedActivation(
    ...parameters: readonly [
      ...FinalizedRunnerActivationParameters,
      ...AdditionalArguments,
    ]
  ): Result;
}
