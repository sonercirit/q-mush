import { createUuidV7 } from "../shared/ids.ts";
import type { RealtimeSocket } from "./realtime-hub.ts";
import { readRunnerConnectMessage } from "./realtime-protocol.ts";
import {
  admitRunnerRegistration,
  receiptStateMatches,
  registrationGate,
} from "./realtime-runner-admission.ts";
import {
  establishPendingRunnerAuthority,
  fenceRunnerRegistration,
  finishRunnerOperational,
  registrationChanged,
  restorePreviousRunnerAuthority,
} from "./realtime-runner-authority.ts";
import {
  finalizeLifecycle,
  finalizePreparedRegistration,
  registeredConnectionMatches,
  runnerConnectionData,
  sendRegistrationMessage,
} from "./realtime-runner-finalization.ts";
import {
  safeSend,
  type PendingRunnerRegistration,
  type RegistrationGate,
  type RunnerRestartState,
  type RunnerSocketData,
} from "./realtime-runner-runtime.ts";
import type {
  RegistrationCoordinatorStep,
  RegistrationStepDefinition,
} from "./realtime-runner-step.ts";
import {
  requireRegistrationTransition,
  type RegistrationTransition,
} from "./realtime-runner-transition.ts";
import type {
  RealtimeReceiptState,
  RealtimeRegistrationDependencies,
} from "./realtime-runner-types.ts";
import type { RunnerConnection } from "./runner-store.ts";
import { readRunnerMetadata } from "./runners.ts";

interface RunnerRegistrationCoordinatorOptions {
  readonly options: RealtimeRegistrationDependencies;
  readonly publishRunners: (userId: string) => void;
  readonly runnerRestarts: Map<string, RunnerRestartState>;
}

function rejectRegistration(socket: RealtimeSocket, reason: string): void {
  socket.close(1008, reason);
}

function currentReceiptState(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
): RealtimeReceiptState | undefined {
  const receiptState = pending.receiptState;
  if (receiptState === undefined) {
    return undefined;
  }
  return receiptStateMatches(options, token, {
    metadata: pending.metadata,
    receiptState,
  });
}

const refreshReceiptState = (
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
): RealtimeReceiptState | undefined => {
  const current = currentReceiptState(options, token, pending);
  if (current !== undefined) {
    pending.receiptState = current;
  }
  return current;
};

function registrationGateIsCurrent(
  gate: RegistrationGate | undefined,
  expected: RegistrationGate,
): gate is RegistrationGate {
  return (
    gate !== undefined &&
    gate.expectedRestartId === expected.expectedRestartId &&
    gate.lifecycle === expected.lifecycle &&
    gate.restartGateRequired === expected.restartGateRequired
  );
}

function currentRegistrationGate(
  options: RealtimeRegistrationDependencies,
  runnerRestarts: ReadonlyMap<string, RunnerRestartState>,
  pending: PendingRunnerRegistration,
): RegistrationGate | undefined {
  const runnerId =
    pending.proposal?.runnerId ?? pending.receiptState?.connection.id;
  if (runnerId === undefined) {
    return undefined;
  }
  const gate = registrationGate(
    options,
    runnerRestarts,
    runnerId,
    pending.gate.expectedRestartId,
    pending.receiptState,
  );
  return registrationGateIsCurrent(gate, pending.gate) ? gate : undefined;
}

interface CommittedRegistrationState {
  readonly connection: RunnerConnection;
  readonly receipt: string;
  readonly receiptState: RealtimeReceiptState | undefined;
}

function finalizedCommittedRegistration(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
): CommittedRegistrationState | undefined {
  const receiptState = pending.receiptState;

  if (receiptState?.phase !== "finalized") {
    return undefined;
  }
  const current = currentReceiptState(options, token, pending);
  if (current === undefined) {
    return undefined;
  }
  const touched = options.runners.touchFinalizedActivation(
    token,
    pending.metadata,
    current.receipt,
  );
  return touched?.connection.id === current.connection.id &&
    touched.connection.userId === current.connection.userId
    ? {
        connection: touched.connection,
        receipt: current.receipt,
        receiptState: current,
      }
    : undefined;
}

function preparedCommittedRegistration(
  pending: PendingRunnerRegistration,
): CommittedRegistrationState | undefined {
  const committed = pending.proposal?.prepare(pending.gate.expectedRestartId);
  return committed?.status === "registered"
    ? {
        connection: committed.connected.connection,
        receipt: committed.activationReceipt,
        receiptState: pending.receiptState,
      }
    : undefined;
}

function committedRegistration(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: PendingRunnerRegistration,
): CommittedRegistrationState | undefined {
  if (pending.receiptState?.phase === "finalized") {
    return finalizedCommittedRegistration(options, token, pending);
  }
  return preparedCommittedRegistration(pending);
}

interface RegistrationAuthorityContext {
  readonly data: RunnerSocketData;
  readonly options: RealtimeRegistrationDependencies;
  readonly pending: PendingRunnerRegistration;
  readonly socket: RealtimeSocket;
}

function installPendingAuthority(
  context: RegistrationAuthorityContext,
): boolean {
  const { data, options, pending, socket } = context;
  if (!establishPendingRunnerAuthority(options, pending, socket, data)) {
    fenceRunnerRegistration(socket, data, "Runner authority transition failed");
    return false;
  }
  return true;
}

function releaseInMemoryRestart(
  runnerRestarts: Map<string, RunnerRestartState>,
  pending: PendingRunnerRegistration,
  gate: RegistrationGate,
): void {
  const runnerId = pending.committed?.id;
  if (
    runnerId !== undefined &&
    gate.restartGateRequired &&
    gate.lifecycle === "restart" &&
    gate.inMemoryRestart !== undefined &&
    runnerRestarts.get(runnerId) === gate.inMemoryRestart
  ) {
    runnerRestarts.delete(runnerId);
  }
}

interface AuthorityTransitionContext extends RunnerRegistrationCoordinatorOptions {
  readonly data: RunnerSocketData;
  readonly pending: PendingRunnerRegistration;
  readonly socket: RealtimeSocket;
}

function finishAuthorityTransition(context: AuthorityTransitionContext): void {
  const { data, options, pending, publishRunners, runnerRestarts, socket } =
    context;
  const gate = pending.gate;
  if (!installPendingAuthority({ data, options, pending, socket })) {
    return;
  }
  finishRunnerOperational(options, publishRunners, socket, data, pending);
  if (data.usable) {
    releaseInMemoryRestart(runnerRestarts, pending, gate);
  }
}

export function createRunnerRegistrationCoordinator({
  options,
  publishRunners,
  runnerRestarts,
}: RunnerRegistrationCoordinatorOptions) {
  function currentTransition(
    socket: RealtimeSocket,
    data: RunnerSocketData,
    registrationId: string,
    reason: string,
    guard: (pending: PendingRunnerRegistration) => boolean,
    requireCurrentGate = false,
  ): RegistrationTransition | undefined {
    const transition = requireRegistrationTransition(
      socket,
      data,
      registrationId,
      reason,
      guard,
    );
    if (
      transition !== undefined &&
      requireCurrentGate &&
      currentRegistrationGate(options, runnerRestarts, transition.pending) ===
        undefined
    ) {
      rejectRegistration(socket, reason);
      return undefined;
    }
    return transition;
  }

  const createRegistrationStep = (
    definition: RegistrationStepDefinition,
  ): RegistrationCoordinatorStep => {
    return (socket, data, registrationId) => {
      const transition = currentTransition(
        socket,
        data,
        registrationId,
        definition.reason,
        definition.guard,
        definition.requireCurrentGate,
      );
      if (transition !== undefined) {
        definition.handle({ data, registrationId, socket }, transition.pending);
      }
    };
  };

  function begin(
    socket: RealtimeSocket,
    data: RunnerSocketData,
    message: string,
  ): void {
    if (data.fenced) {
      socket.close(1008, "Runner connection was replaced");
      return;
    }
    if (
      data.registration !== undefined ||
      data.committed !== undefined ||
      data.runner !== undefined
    ) {
      rejectRegistration(socket, "Registration acknowledgement rejected");
      return;
    }
    const connect = readRunnerConnectMessage(message);
    const metadata = readRunnerMetadata({
      architecture: connect.architecture,
      machineId: connect.machineId,
      name: connect.name,
      platform: connect.platform,
    });
    const admitted =
      metadata === undefined
        ? undefined
        : admitRunnerRegistration(
            options,
            runnerRestarts,
            data.token,
            metadata,
            connect.activationReceipt?.value,
            connect.restartId,
          );
    if (admitted === undefined) {
      rejectRegistration(socket, "Registration rejected");
      return;
    }
    const registrationId = createUuidV7();
    const selectedMetadata = admitted.metadata;
    data.registration = {
      activeSent: false,
      committed: undefined,
      finalizationAcknowledged: false,
      finalizedReceipt: undefined,
      gate: admitted.gate,
      lifecycleCallbackCompleted: false,
      metadata: selectedMetadata,
      operationalSent: false,
      preparedReceipt: undefined,
      previousAuthority: undefined,
      proposal: admitted.proposal,
      receiptState: admitted.receiptState,
      registrationId,
    };
    if (
      !safeSend(
        socket,
        JSON.stringify({
          registrationId,
          runnerId: admitted.runnerId,
          type: "registration_ready",
          version: options.runnerVersion,
        }),
      )
    ) {
      fenceRunnerRegistration(
        socket,
        data,
        "Runner registration proposal failed",
      );
    }
  }

  const commit = createRegistrationStep({
    guard: (pending) => pending.committed === undefined,
    handle: ({ data, registrationId, socket }, pending) => {
      const selectedRunnerId =
        pending.proposal?.runnerId ?? pending.receiptState?.connection.id;
      const committed = committedRegistration(options, data.token, pending);
      if (
        committed === undefined ||
        committed.connection.id !== selectedRunnerId
      ) {
        registrationChanged(socket, data);
        return;
      }
      pending.committed = committed.connection;
      pending.preparedReceipt = committed.receipt;
      pending.receiptState = committed.receiptState;
      data.committed = {
        connection: pending.committed,
        registrationId,
      };
      if (
        !sendRegistrationMessage(
          socket,
          registrationId,
          "registration_committed",
        )
      ) {
        fenceRunnerRegistration(
          socket,
          data,
          "Runner registration commitment failed",
        );
      }
    },
    reason: "Registration acknowledgement rejected",
    requireCurrentGate: true,
  });

  const sendActive = createRegistrationStep({
    guard: (pending) => {
      const committed = pending.committed;
      return (
        committed !== undefined &&
        !pending.activeSent &&
        pending.preparedReceipt !== undefined
      );
    },
    handle: ({ data, registrationId, socket }, pending) => {
      if (
        !safeSend(
          socket,
          JSON.stringify({
            activationReceipt: pending.preparedReceipt,
            registrationId,
            type: "registration_active",
          }),
        )
      ) {
        fenceRunnerRegistration(socket, data, "Runner activation failed");
        return;
      }
      pending.activeSent = true;
    },
    reason: "Registration receipt rejected",
    requireCurrentGate: true,
  });

  const activate = createRegistrationStep({
    guard: (pending) =>
      pending.committed !== undefined &&
      pending.activeSent &&
      pending.preparedReceipt !== undefined,
    handle: ({ data, registrationId, socket }, pending) => {
      const committed = pending.committed;
      const connected =
        pending.receiptState?.phase === "finalized"
          ? runnerConnectionData(pending)
          : finalizePreparedRegistration(options, data.token, pending);
      if (
        committed === undefined ||
        connected === undefined ||
        !registeredConnectionMatches(committed, connected)
      ) {
        registrationChanged(socket, data);
        return;
      }
      pending.committed = connected.connection;
      pending.finalizedReceipt = pending.preparedReceipt;
      if (
        !safeSend(
          socket,
          JSON.stringify({
            activationReceipt: pending.finalizedReceipt,
            registrationId,
            type: "registration_finalized",
          }),
        )
      ) {
        fenceRunnerRegistration(socket, data, "Runner finalization failed");
      }
    },
    reason: "Registration activation rejected",
    requireCurrentGate: true,
  });

  const acknowledgeFinalization = createRegistrationStep({
    guard: (pending) =>
      pending.committed !== undefined &&
      pending.finalizedReceipt !== undefined &&
      !pending.finalizationAcknowledged,
    handle: ({ data, registrationId, socket }, pending) => {
      const gate = currentRegistrationGate(options, runnerRestarts, pending);
      if (gate === undefined) {
        rejectRegistration(socket, "Restart identity rejected");
        return;
      }
      if (refreshReceiptState(options, data.token, pending) === undefined) {
        fenceRunnerRegistration(
          socket,
          data,
          "Runner lifecycle settlement failed",
        );
        return;
      }
      const committed = pending.committed;
      if (committed === undefined) {
        fenceRunnerRegistration(
          socket,
          data,
          "Runner lifecycle settlement failed",
        );
        return;
      }
      const receiptState = finalizeLifecycle(
        options,
        pending,
        gate,
        options.hub.currentRunner(committed.id) === undefined &&
          pending.receiptState?.lifecycle === "ordinary",
      );
      if (receiptState === undefined) {
        fenceRunnerRegistration(
          socket,
          data,
          "Runner lifecycle settlement failed",
        );
        return;
      }
      pending.receiptState = receiptState;
      pending.finalizationAcknowledged = true;
      if (
        !sendRegistrationMessage(
          socket,
          registrationId,
          "registration_operational",
        )
      ) {
        data.runner = undefined;
        fenceRunnerRegistration(
          socket,
          data,
          "Runner operational transition failed",
        );
        return;
      }
      pending.operationalSent = true;
    },
    reason: "Registration finalization rejected",
  });

  const operational = createRegistrationStep({
    guard: (pending) =>
      pending.committed !== undefined &&
      pending.finalizationAcknowledged &&
      pending.operationalSent,
    handle: ({ data, socket }, pending) => {
      finishAuthorityTransition({
        data,
        options,
        pending,
        publishRunners,
        runnerRestarts,
        socket,
      });
    },
    reason: "Registration operational acknowledgement rejected",
  });

  function closed(socket: RealtimeSocket, data: RunnerSocketData): void {
    const pending = data.registration;
    if (pending !== undefined && data.runner !== undefined && !data.usable) {
      restorePreviousRunnerAuthority(options, pending, socket);
      data.runner = undefined;
    }
  }

  return {
    acknowledgeFinalization,
    activate,
    begin,
    closed,
    commit,
    operational,
    sendActive,
  };
}
