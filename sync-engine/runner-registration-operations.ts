import type {
  FinalizedRunnerActivationOperations,
  RunnerActivationLifecycleOperations,
} from "./runner-activation-operations.ts";
import type {
  RunnerActivationReceiptState,
  RunnerMetadata,
  RunnerRegistrationActivationResult,
  RunnerRegistrationCommitResult,
  RunnerRegistrationFence,
  RunnerRegistrationFinalizeOptions,
  RunnerRegistrationPreflight,
  RunnerRegistrationPreflightResult,
  RunnerRegistrationPrepareOptions,
  RunnerRegistrationResult,
} from "./runner-registration-types.ts";

export interface RunnerRegistrationOperations
  extends
    RunnerActivationLifecycleOperations,
    FinalizedRunnerActivationOperations {
  commit(
    preflight: RunnerRegistrationPreflight,
    options: RunnerRegistrationPrepareOptions,
  ): RunnerRegistrationCommitResult;
  fenceIsCurrent(fence: RunnerRegistrationFence): boolean;
  finalizeRegistration(
    fence: RunnerRegistrationFence,
    options: RunnerRegistrationFinalizeOptions,
  ): RunnerRegistrationActivationResult;
  preflight(
    token: string,
    metadata: RunnerMetadata,
    activationId?: string,
  ): RunnerRegistrationPreflightResult;
  receipt(fence: RunnerRegistrationFence): string;
  receiptState(
    token: string,
    metadata: RunnerMetadata,
    receipt: string,
  ): RunnerActivationReceiptState | undefined;
  register(
    token: string,
    metadata: RunnerMetadata,
    now: number,
  ): RunnerRegistrationResult;
}
