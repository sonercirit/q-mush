import type { RealtimeSocket } from "./realtime-hub.ts";
import type {
  PendingRunnerRegistration,
  RunnerSocketData,
} from "./realtime-runner-runtime.ts";

interface RegistrationStep {
  readonly data: RunnerSocketData;
  readonly registrationId: string;
  readonly socket: RealtimeSocket;
}

type RegistrationStepHandler = (
  step: RegistrationStep,
  pending: PendingRunnerRegistration,
) => void;

export type RegistrationCoordinatorStep = (
  socket: RealtimeSocket,
  data: RunnerSocketData,
  registrationId: string,
) => void;

export interface RegistrationStepDefinition {
  readonly guard: (pending: PendingRunnerRegistration) => boolean;
  readonly handle: RegistrationStepHandler;
  readonly reason: string;
  readonly requireCurrentGate?: boolean;
}
