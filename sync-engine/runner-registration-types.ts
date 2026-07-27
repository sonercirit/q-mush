import type { runners } from "../shared/database/schema.ts";

export interface RunnerConnection {
  readonly id: string;
  readonly userId: string;
}

export interface RunnerMetadata {
  readonly architecture: string;
  readonly machineFingerprint: string;
  readonly name: string;
  readonly platform: string;
}

type RunnerActivationReceiptPhase = "finalized" | "prepared";
export type RunnerActivationLifecycle = "ordinary" | "restart";

export interface RunnerRegistrationFence extends RunnerMetadata {
  readonly activationId: string;
  readonly generation: number;
  readonly lifecycle: RunnerActivationLifecycle;
  readonly phase: RunnerActivationReceiptPhase;
  readonly restartId: string | undefined;
  readonly sourceId: string;
  readonly targetGeneration: number;
  readonly targetId: string;
  readonly tokenDigest: string;
  readonly tokenHash: string;
  readonly userId: string;
}

export type StoredRunnerRegistration = Pick<
  typeof runners.$inferSelect,
  | "activationArchitecture"
  | "activationGeneration"
  | "activationId"
  | "activationLifecycle"
  | "activationLifecycleSettled"
  | "activationMachineFingerprint"
  | "activationName"
  | "activationPhase"
  | "activationPlatform"
  | "activationReservationGeneration"
  | "activationReservationId"
  | "activationReservationSourceId"
  | "activationRestartId"
  | "activationSourceId"
  | "activationTargetGeneration"
  | "activationTargetId"
  | "architecture"
  | "id"
  | "isGlobal"
  | "machineFingerprint"
  | "name"
  | "platform"
  | "tokenDigest"
  | "tokenHash"
  | "userId"
>;

export interface RunnerRegistrationPreflight {
  readonly activationId: string;
  readonly metadata: RunnerMetadata;
  readonly source: StoredRunnerRegistration;
  readonly target: StoredRunnerRegistration;
  readonly tokenDigest: string;
}

interface CommittedRunnerRegistration {
  readonly connection: RunnerConnection;
  readonly fence: RunnerRegistrationFence;
}

export type RunnerRegistrationPreflightResult =
  | {
      readonly connection: RunnerConnection;
      readonly registration: RunnerRegistrationPreflight;
      readonly status: "ready";
    }
  | {
      readonly status:
        | "registration_changed"
        | "runner_exists"
        | "token_already_used"
        | "unknown_token";
    };

export type RunnerRegistrationCommitResult =
  | {
      readonly registration: CommittedRunnerRegistration;
      readonly status: "registered";
    }
  | { readonly status: "registration_changed" };

export type RunnerRegistrationActivationResult =
  | { readonly connection: RunnerConnection; readonly status: "activated" }
  | { readonly status: "registration_changed" };

export interface RunnerActivationReceiptState {
  readonly activationId: string;
  readonly connection: RunnerConnection;
  readonly lifecycle: RunnerActivationLifecycle;
  readonly lifecycleSettled: boolean;
  readonly phase: RunnerActivationReceiptPhase;
  readonly restartId: string | undefined;
}

export type RunnerRegistrationResult =
  | { readonly id: string; readonly status: "registered" }
  | {
      readonly status:
        "registration_changed" | "runner_exists" | "token_already_used";
    }
  | { readonly status: "unknown_token" };

export interface RunnerRegistrationPrepareOptions {
  readonly lifecycle: RunnerActivationLifecycle;
  readonly now: number;
  readonly restartId?: string;
}

export interface RunnerRegistrationFinalizeOptions {
  readonly now: number;
  readonly receipt: string;
}
