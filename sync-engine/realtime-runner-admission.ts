import { createUuidV7 } from "../shared/ids.ts";
import type { RunnerAdmissionContext } from "./realtime-runner-admission-types.ts";
import type {
  RegistrationGate,
  RunnerRestartState,
} from "./realtime-runner-runtime.ts";
import type {
  RealtimeReceiptState,
  RealtimeRegistrationDependencies,
} from "./realtime-runner-types.ts";
import type { RunnerMetadata } from "./runner-store.ts";
import type { RunnerRegistrationProposal } from "./runners.ts";

export interface AdmittedRunnerRegistration {
  readonly gate: RegistrationGate;
  readonly metadata: RunnerMetadata;
  readonly proposal: RunnerRegistrationProposal | undefined;
  readonly receiptState: RealtimeReceiptState | undefined;
  readonly runnerId: string;
}

export function registrationGate(
  options: RealtimeRegistrationDependencies,
  runnerRestarts: ReadonlyMap<string, RunnerRestartState>,
  runnerId: string,
  restartId: string | undefined,
  receiptState?: RealtimeReceiptState,
): RegistrationGate | undefined {
  const inMemoryRestart = runnerRestarts.get(runnerId);
  const durableRestart = options.sessions.pendingRunnerRestart(runnerId);
  const durableRestartId =
    durableRestart.status === "pending" &&
    durableRestart.requestedBy === "runner"
      ? durableRestart.restartId
      : undefined;
  if (
    durableRestart.status === "conflicted" ||
    (durableRestart.status === "pending" &&
      durableRestart.requestedBy !== "runner") ||
    (inMemoryRestart !== undefined &&
      durableRestartId !== undefined &&
      inMemoryRestart.restartId !== durableRestartId)
  ) {
    return undefined;
  }
  const expectedRestartId = inMemoryRestart?.restartId ?? durableRestartId;
  if (expectedRestartId !== undefined) {
    return restartId === expectedRestartId
      ? {
          expectedRestartId,
          inMemoryRestart,
          lifecycle: "restart",
          restartGateRequired: true,
        }
      : undefined;
  }
  if (
    durableRestart.status === "none" &&
    inMemoryRestart === undefined &&
    receiptState?.lifecycle === "restart" &&
    receiptState.restartId !== undefined &&
    restartId === receiptState.restartId
  ) {
    return {
      expectedRestartId: receiptState.restartId,
      inMemoryRestart: undefined,
      lifecycle: "restart",
      restartGateRequired: false,
    };
  }
  return restartId === undefined
    ? {
        expectedRestartId: undefined,
        inMemoryRestart: undefined,
        lifecycle: "ordinary",
        restartGateRequired: false,
      }
    : undefined;
}

function classifyReceipt(
  options: RealtimeRegistrationDependencies,
  token: string,
  metadata: RunnerMetadata,
  receipt: string | undefined,
): RealtimeReceiptState | undefined {
  if (receipt === undefined) {
    return undefined;
  }
  const classified = options.runners.receiptState(token, metadata, receipt);
  return classified === undefined ? undefined : { ...classified, receipt };
}

function exactReceiptGate(
  receipt: RealtimeReceiptState,
  gate: RegistrationGate,
): boolean {
  return (
    receipt.lifecycle === gate.lifecycle &&
    receipt.restartId === gate.expectedRestartId
  );
}

function gatedRegistration(
  gate: RegistrationGate,
  metadata: RunnerMetadata,
  receiptState: RealtimeReceiptState | undefined,
  proposal: RunnerRegistrationProposal | undefined,
  runnerId: string,
): AdmittedRunnerRegistration {
  return { gate, metadata, proposal, receiptState, runnerId };
}

function proposalAdmission(
  context: RunnerAdmissionContext,
  token: string,
  metadata: RunnerMetadata,
  receiptState: RealtimeReceiptState | undefined,
  restartId: string | undefined,
): AdmittedRunnerRegistration | undefined {
  const activationId = receiptState?.activationId ?? createUuidV7();
  const proposal = context.options.runners.preflightRegistration(
    token,
    metadata,
    activationId,
  );
  if (proposal === undefined) {
    return undefined;
  }
  const gate = registrationGate(
    context.options,
    context.runnerRestarts,
    proposal.runnerId,
    restartId,
    receiptState,
  );
  if (
    gate === undefined ||
    (receiptState !== undefined &&
      (receiptState.phase !== "prepared" ||
        receiptState.activationId !== proposal.activationId ||
        receiptState.connection.id !== proposal.runnerId ||
        !exactReceiptGate(receiptState, gate)))
  ) {
    return undefined;
  }
  return gatedRegistration(
    gate,
    metadata,
    receiptState,
    proposal,
    proposal.runnerId,
  );
}

export function admitRunnerRegistration(
  options: RealtimeRegistrationDependencies,
  runnerRestarts: ReadonlyMap<string, RunnerRestartState>,
  token: string,
  metadata: RunnerMetadata,
  incomingReceipt: string | undefined,
  restartId: string | undefined,
): AdmittedRunnerRegistration | undefined {
  const receiptState = classifyReceipt(
    options,
    token,
    metadata,
    incomingReceipt,
  );
  if (incomingReceipt !== undefined && receiptState === undefined) {
    return undefined;
  }
  if (receiptState?.phase !== "finalized") {
    return proposalAdmission(
      { options, runnerRestarts },
      token,
      metadata,
      receiptState,
      restartId,
    );
  }
  const gate = registrationGate(
    options,
    runnerRestarts,
    receiptState.connection.id,
    restartId,
    receiptState,
  );
  return gate === undefined || !exactReceiptGate(receiptState, gate)
    ? undefined
    : gatedRegistration(
        gate,
        metadata,
        receiptState,
        undefined,
        receiptState.connection.id,
      );
}

function receiptStateEquals(
  current: RealtimeReceiptState,
  expected: RealtimeReceiptState,
): boolean {
  return (
    current.activationId === expected.activationId &&
    current.connection.id === expected.connection.id &&
    current.connection.userId === expected.connection.userId &&
    current.lifecycle === expected.lifecycle &&
    current.phase === expected.phase &&
    current.restartId === expected.restartId &&
    (!expected.lifecycleSettled || current.lifecycleSettled)
  );
}

export function receiptStateMatches(
  options: RealtimeRegistrationDependencies,
  token: string,
  pending: Readonly<{
    metadata: RunnerMetadata;
    receiptState: RealtimeReceiptState;
  }>,
): RealtimeReceiptState | undefined {
  const expected = pending.receiptState;
  const current = classifyReceipt(
    options,
    token,
    pending.metadata,
    expected.receipt,
  );
  return current !== undefined && receiptStateEquals(current, expected)
    ? current
    : undefined;
}
