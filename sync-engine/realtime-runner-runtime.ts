import type { RealtimeSocket } from "./realtime-hub.ts";
import type { RealtimeReceiptState } from "./realtime-runner-types.ts";
import type { RunnerConnection, RunnerMetadata } from "./runner-store.ts";
import type { RunnerRegistrationProposal } from "./runners.ts";

interface CommittedRunnerRegistration {
  readonly connection: RunnerConnection;
  readonly registrationId: string;
}

export interface RegistrationGate {
  readonly expectedRestartId: string | undefined;
  readonly inMemoryRestart: RunnerRestartState | undefined;
  readonly lifecycle: "ordinary" | "restart";
  readonly restartGateRequired: boolean;
}

export interface PendingRunnerRegistration {
  activeSent: boolean;
  committed: RunnerConnection | undefined;
  finalizationAcknowledged: boolean;
  finalizedReceipt: string | undefined;
  readonly gate: RegistrationGate;
  lifecycleCallbackCompleted: boolean;
  readonly metadata: RunnerMetadata;
  operationalSent: boolean;
  preparedReceipt: string | undefined;
  previousAuthority: RealtimeSocket | undefined;
  readonly proposal: RunnerRegistrationProposal | undefined;
  receiptState: RealtimeReceiptState | undefined;
  readonly registrationId: string;
}

export interface RunnerSocketData {
  readonly kind: "runner";
  committed: CommittedRunnerRegistration | undefined;
  fenced: boolean;
  registration: PendingRunnerRegistration | undefined;
  runner: RunnerConnection | undefined;
  readonly token: string;
  usable: boolean;
}

export interface RunnerRestartState {
  readonly promise: Promise<void>;
  readonly restartId: string;
  settled: boolean;
}

export function safeSend(socket: RealtimeSocket, message: string): boolean {
  try {
    return socket.send(message) !== 0;
  } catch {
    return false;
  }
}

export function closeServerError(socket: RealtimeSocket, reason: string): void {
  try {
    socket.close(1011, reason);
  } catch {
    // The peer may already have closed the socket.
  }
}
