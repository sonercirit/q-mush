import type { RealtimeSocket } from "./realtime-hub.ts";
import type {
  PendingRunnerRegistration,
  RunnerSocketData,
} from "./realtime-runner-runtime.ts";

export type RegistrationStageGuard = (
  pending: PendingRunnerRegistration,
) => boolean;

export interface RegistrationTransition {
  readonly data: RunnerSocketData;
  readonly pending: PendingRunnerRegistration;
  readonly registrationId: string;
  readonly socket: RealtimeSocket;
}

export function requireRegistrationTransition(
  socket: RealtimeSocket,
  data: RunnerSocketData,
  registrationId: string,
  reason: string,
  guard: RegistrationStageGuard,
): RegistrationTransition | undefined {
  const pending = data.registration;
  if (pending?.registrationId !== registrationId || !guard(pending)) {
    socket.close(1008, reason);
    return undefined;
  }
  return { data, pending, registrationId, socket };
}
