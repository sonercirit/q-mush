import type { RealtimeSocket } from "./realtime-hub.ts";
import { readRunnerRegistrationMessage } from "./realtime-protocol.ts";
import type { createRunnerRegistrationCoordinator } from "./realtime-runner-registration.ts";
import type { RunnerSocketData } from "./realtime-runner-runtime.ts";

type RunnerRegistrationCoordinator = ReturnType<
  typeof createRunnerRegistrationCoordinator
>;

export function handleRunnerRegistrationAcknowledgement(
  registration: RunnerRegistrationCoordinator,
  socket: RealtimeSocket,
  data: RunnerSocketData,
  message: string,
): void {
  const registrationMessage = readRunnerRegistrationMessage(message);
  const id = registrationMessage.registrationId;
  switch (registrationMessage.type) {
    case "registration_accept":
      registration.commit(socket, data, id);
      return;
    case "registration_received":
      registration.sendActive(socket, data, id);
      return;
    case "registration_active_received":
      registration.activate(socket, data, id);
      return;
    case "registration_finalized_received":
      registration.acknowledgeFinalization(socket, data, id);
      return;
    case "registration_operational_received":
      registration.operational(socket, data, id);
  }
}
