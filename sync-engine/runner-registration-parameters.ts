import type {
  RunnerActivationLifecycle,
  RunnerMetadata,
} from "./runner-registration-types.ts";

export type RunnerLifecycleParameters = readonly [
  activationId: string,
  lifecycle: RunnerActivationLifecycle,
  restartId?: string,
];

export type FinalizedRunnerActivationParameters = readonly [
  token: string,
  metadata: RunnerMetadata,
  receipt: string,
];
