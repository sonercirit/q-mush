import type { RealtimeSocket } from "./realtime-hub.ts";
import { pendingRunnerConnection } from "./realtime-runner-connection.ts";
import type {
  PendingRunnerRegistration,
  RegistrationGate,
} from "./realtime-runner-runtime.ts";
import type {
  RealtimeReceiptState,
  RealtimeRegistrationDependencies,
} from "./realtime-runner-types.ts";
import type { RunnerConnection } from "./runner-store.ts";
import type { RunnerActivationReceiptValidation } from "./runners.ts";

export function registeredConnectionMatches(
  runner: RunnerConnection,
  connected: Readonly<{ connection: RunnerConnection }>,
): boolean {
  return (
    connected.connection.id === runner.id &&
    connected.connection.userId === runner.userId
  );
}

export const runnerConnectionData = pendingRunnerConnection;

function lifecycleActivationId(
  pending: PendingRunnerRegistration,
): string | undefined {
  return pending.proposal?.activationId ?? pending.receiptState?.activationId;
}

function finalizedReceiptMatches(
  current: RunnerActivationReceiptValidation,
  pending: PendingRunnerRegistration,
  exactLifecycle: boolean,
): boolean {
  const runner = pending.committed;
  const activationId = lifecycleActivationId(pending);
  if (runner === undefined || activationId === undefined) {
    return false;
  }
  return (
    current.phase === "finalized" &&
    current.activationId === activationId &&
    current.connection.id === runner.id &&
    current.connection.userId === runner.userId &&
    (!exactLifecycle ||
      (current.lifecycle === pending.gate.lifecycle &&
        current.restartId === pending.gate.expectedRestartId))
  );
}

function shouldReplaySettledFinalization(
  pending: PendingRunnerRegistration,
): boolean {
  return pending.proposal?.replaysSettledFinalization === true;
}

function acceptedFinalizedReceipt(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
  connected: Readonly<{ connection: RunnerConnection }>,
): RealtimeReceiptState | undefined {
  const receipt = pending.preparedReceipt;
  if (pending.proposal === undefined || receipt === undefined) {
    return undefined;
  }
  const current = options.runners.receiptState(
    token,
    pending.metadata,
    receipt,
  );
  const replayingSettledFinalization = shouldReplaySettledFinalization(pending);
  return current?.lifecycleSettled === replayingSettledFinalization &&
    finalizedReceiptMatches(current, pending, !replayingSettledFinalization) &&
    current.connection.id === connected.connection.id &&
    current.connection.userId === connected.connection.userId
    ? { ...current, receipt }
    : undefined;
}

export type PendingRunnerConnection = ReturnType<
  typeof pendingRunnerConnection
>;

export function finalizePreparedRegistration(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
): PendingRunnerConnection {
  const runner = pending.committed;
  const proposal = pending.proposal;
  const receipt = pending.preparedReceipt;
  if (runner === undefined || proposal === undefined || receipt === undefined) {
    return undefined;
  }
  const activated = proposal.finalize(receipt);
  if (
    activated.status !== "activated" ||
    !registeredConnectionMatches(runner, activated.connected)
  ) {
    return undefined;
  }
  const receiptState = acceptedFinalizedReceipt(
    options,
    token,
    pending,
    activated.connected,
  );
  if (receiptState === undefined) {
    return undefined;
  }
  pending.receiptState = receiptState;
  return activated.connected;
}

function settleActivationLifecycle(
  options: RealtimeRegistrationDependencies,
  activationId: string,
  gate: RegistrationGate,
): boolean {
  try {
    return options.runners.settleActivationLifecycle(
      activationId,
      gate.lifecycle,
      gate.expectedRestartId,
    );
  } catch {
    return false;
  }
}

function executeLifecycleCallback(
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  gate: RegistrationGate,
): boolean {
  if (pending.lifecycleCallbackCompleted) {
    return true;
  }
  const runner = pending.committed;
  if (runner === undefined) {
    return false;
  }
  try {
    if (gate.lifecycle === "restart" && gate.restartGateRequired) {
      const restartId = gate.expectedRestartId;
      if (restartId === undefined) {
        return false;
      }
      options.sessions.runnerRestartReady(runner.id, restartId);
    } else {
      options.sessions.runnerConnected(runner.id);
    }
    pending.lifecycleCallbackCompleted = true;
    return true;
  } catch {
    return false;
  }
}

function finalizedReceiptState(
  pending: PendingRunnerRegistration,
  gate: RegistrationGate,
): RealtimeReceiptState | undefined {
  const activationId = lifecycleActivationId(pending);
  const connection = pending.committed;
  const receipt = pending.finalizedReceipt;
  if (
    activationId === undefined ||
    connection === undefined ||
    receipt === undefined
  ) {
    return undefined;
  }
  return {
    activationId,
    connection,
    lifecycle: gate.lifecycle,
    lifecycleSettled: true,
    phase: "finalized",
    receipt,
    restartId: gate.expectedRestartId,
  };
}

export function finalizeLifecycle(
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  gate: RegistrationGate,
  replayConnection: boolean,
): RealtimeReceiptState | undefined {
  if (pending.receiptState?.lifecycleSettled === true) {
    if (shouldReplaySettledFinalization(pending) || replayConnection) {
      return executeLifecycleCallback(options, pending, gate)
        ? pending.receiptState
        : undefined;
    }
    return pending.receiptState;
  }
  const activationId = lifecycleActivationId(pending);
  if (activationId === undefined) {
    return undefined;
  }
  if (!executeLifecycleCallback(options, pending, gate)) {
    return undefined;
  }
  if (!settleActivationLifecycle(options, activationId, gate)) {
    pending.lifecycleCallbackCompleted = false;
    return undefined;
  }
  return finalizedReceiptState(pending, gate);
}

export function sendRegistrationMessage(
  socket: RealtimeSocket,
  registrationId: string,
  type: "registration_committed" | "registration_operational",
): boolean {
  try {
    return socket.send(JSON.stringify({ registrationId, type })) !== 0;
  } catch {
    return false;
  }
}
