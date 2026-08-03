import { expect } from "vitest";
import { runnerRegistrationRejectedMessage } from "../../shared/runner-realtime-protocol.ts";
import { type createRealtimeIntegration } from "../../sync-engine/realtime.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  ORDINARY_RUNNER_RECEIPT_SCOPE,
  runnerRestartGate,
  type RealtimeRunnerOverrides,
  type RealtimeSessionOverrides,
  type RunnerReceiptScope,
} from "./realtime-test-helpers.ts";
import {
  beginRunnerRestart,
  connectedRecordedRunnerRealtimeTestSocket,
  finalizedRunnerActivationReceipts,
  optionalRunnerRestartId,
  reconnectRunnerRealtimeTestSocket,
  registrationActiveMessage,
  registrationCommittedMessage,
  registrationFinalizedMessage,
  registrationOperationalMessage,
  runnerReadyMessage,
  runnerRestartReadyMessage,
  sendRealtimeMessage,
  sendRunnerConnectProposal,
  type RealtimeSendFailure,
  type RunnerConnectOptions,
} from "./realtime-test-socket-helpers.ts";

export interface MutableDurableGate {
  restartId: string | undefined;
}

export function unsetDurableGate(): MutableDurableGate {
  return { restartId: undefined };
}

function recordedStringLists(...names: readonly string[]) {
  return Object.fromEntries(names.map((name) => [name, Array<string>()]));
}

export function restartRecords() {
  const records = recordedStringLists("recovered", "resumed");
  return {
    recovered: records["recovered"] ?? [],
    resumed: records["resumed"] ?? [],
  };
}

export interface RunnerReconnectCase {
  readonly machineId: string;
  readonly restartId: string | undefined;
}

export const conflictReconnects: readonly RunnerReconnectCase[] = [
  { machineId: "machine-durable-conflict", restartId: undefined },
  { machineId: "machine-durable-conflict", restartId: "restart-one" },
  { machineId: "machine-durable-conflict", restartId: "restart-two" },
];

function failedRegistrationSend(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  failure: RealtimeSendFailure,
  successfulSendsBeforeFailure: number,
  options: RunnerConnectOptions = {},
) {
  return connectedRecordedRunnerRealtimeTestSocket(realtime, machineId, {
    ...options,
    failure,
    successfulSendsBeforeFailure,
  });
}

interface FailedRegistrationOptions extends RunnerConnectOptions {
  readonly activationReceiptPhase?: "finalized" | "prepared";
}

function failedRegistrationAtStage(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  failure: RealtimeSendFailure,
  successfulSendsBeforeFailure: 2 | 3,
  options: FailedRegistrationOptions = {},
) {
  const { activationReceiptPhase, ...connectOptions } = options;
  return failedRegistrationSend(
    realtime,
    machineId,
    failure,
    successfulSendsBeforeFailure,
    {
      ...connectOptions,
      ...(activationReceiptPhase === undefined
        ? {}
        : { claimedActivationReceiptPhase: activationReceiptPhase }),
    },
  );
}

export const failedCommittedRegistration = (
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  failure: RealtimeSendFailure,
  restartId?: string,
  activationReceipt?: string,
  claimedActivationReceiptPhase?: "finalized" | "prepared",
) => {
  const options: FailedRegistrationOptions = {
    ...optionalRunnerRestartId(restartId),
    ...(activationReceipt === undefined ? {} : { activationReceipt }),
    ...(claimedActivationReceiptPhase === undefined
      ? {}
      : { activationReceiptPhase: claimedActivationReceiptPhase }),
  };
  return failedRegistrationAtStage(realtime, machineId, failure, 2, options);
};

export const failedFinalizedRegistration = (
  registration: Readonly<{
    realtime: ReturnType<typeof createRealtimeIntegration>;
  }>,
  machineId: string,
  failure: RealtimeSendFailure,
  restartId?: string,
) =>
  failedRegistrationAtStage(
    registration.realtime,
    machineId,
    failure,
    3,
    optionalRunnerRestartId(restartId),
  );

export function expectCommittedRegistrationFailure(
  connection: ReturnType<typeof connectedRecordedRunnerRealtimeTestSocket>,
): void {
  expect(connection.record.closed).toEqual([1011, "Runner activation failed"]);
}

export function restartGateScenario(pendingRunnerRestart: string) {
  const resumed: string[] = [];
  return {
    realtime: restartGateIntegration(resumed, pendingRunnerRestart),
    resumed,
  };
}

export async function expectRestartReady(
  socket: Readonly<{ sent: readonly string[] }>,
  restartId: string,
): Promise<void> {
  await Promise.resolve();
  expect(socket.sent).toContain(runnerRestartReadyMessage(restartId));
}

function restartGateIntegration(
  resumed: string[],
  pendingRunnerRestart?: string,
) {
  return connectedRunnerRealtimeTestIntegration({
    ...(pendingRunnerRestart === undefined
      ? {}
      : {
          pendingRunnerRestart: () => runnerRestartGate(pendingRunnerRestart),
        }),
    runnerRestartReady: recordRestartReady(resumed),
  });
}

export interface RestartGateScenario {
  readonly durableRestartId?: string;
  readonly machineId: string;
  readonly rejectedRestartIds: readonly (string | undefined)[];
  readonly restartId: string;
}

export async function initializedRestartGateTest(
  resumed: string[],
  scenario: RestartGateScenario,
) {
  const realtime = restartGateIntegration(resumed, scenario.durableRestartId);
  beginRunnerRestart(realtime, scenario.machineId, scenario.restartId);
  await Promise.resolve();
  const rejected = scenario.rejectedRestartIds.map((restartId) =>
    reconnectRunnerRealtimeTestSocket(realtime, scenario.machineId, {
      ...(restartId === undefined ? {} : { restartId }),
    }),
  );
  return { realtime, rejected };
}

export function emptyRecordedValues(
  ...values: readonly (readonly unknown[])[]
): void {
  for (const value of values) {
    expect(value).toEqual([]);
  }
}

export function expectRejectedConnection(
  sent: readonly string[],
  effects: readonly unknown[],
): void {
  expect(sent).toEqual([runnerRegistrationRejectedMessage()]);
  expect(effects).toEqual([]);
}

export function expectRejectedSockets(
  sockets: readonly { readonly sent: readonly string[] }[],
): void {
  expect(sockets.map(({ sent }) => sent)).toEqual(
    sockets.map(() => [runnerRegistrationRejectedMessage()]),
  );
}

export function expectCount(value: number, expected: number): void {
  expect(value).toBe(expected);
}

export function expectFencedRunnerData(data: unknown): void {
  expect(data).toMatchObject({ runner: undefined, usable: false });
}

export function finalizedRunnerRealtimeTestIntegration(
  sessionOverrides: RealtimeSessionOverrides = {},
  runnerOverrides: RealtimeRunnerOverrides = {},
  receiptScope: RunnerReceiptScope = ORDINARY_RUNNER_RECEIPT_SCOPE,
) {
  return connectedRunnerRealtimeTestIntegration(
    sessionOverrides,
    runnerOverrides,
    finalizedRunnerActivationReceipts(),
    receiptScope,
  );
}

export function expectUsableRunner(
  connection: Readonly<{ data: unknown; sent: readonly string[] }>,
  runnerId?: string,
): void {
  expect(connection.sent).toHaveLength(5);
  expect(connection.data).toMatchObject({
    ...(runnerId === undefined ? {} : { runner: { id: runnerId } }),
    usable: true,
  });
}

export function expectRetrySequence(
  first: { readonly data: unknown; readonly sent: readonly string[] },
  retry: { readonly data: unknown; readonly sent: readonly string[] },
): void {
  expect(first.sent).toHaveLength(4);
  expectFencedRunnerData(first.data);
  expectUsableRunner(retry);
}

export function reconnectRunnerCases(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  cases: readonly RunnerReconnectCase[],
) {
  return cases.map((reconnect) =>
    reconnectRunnerRealtimeTestSocket(realtime, reconnect.machineId, {
      ...(reconnect.restartId === undefined
        ? {}
        : { restartId: reconnect.restartId }),
    }),
  );
}

function increment(onIncrement: () => void) {
  return (): void => {
    onIncrement();
  };
}

export function seenRecorder(onSeen: () => void) {
  return { seen: increment(onSeen) };
}

export function recordCommandEffects(completed: string[], drained: string[]) {
  return {
    completeRunnerCommand: (_runnerId: string, commandId: string) => {
      completed.push(commandId);
      return true;
    },
    drainRunner: (_runnerId: string, restartId: string) => {
      drained.push(restartId);
      return Promise.resolve();
    },
  };
}

export function createRecordedRunnerEffects() {
  const records = recordedStringLists(
    "connected",
    "disconnected",
    "presence",
    "resumed",
  );
  return {
    connected: records["connected"] ?? [],
    disconnected: records["disconnected"] ?? [],
    presence: records["presence"] ?? [],
    resumed: records["resumed"] ?? [],
  };
}

export function recordDisconnected(values: string[]) {
  return ({ id }: Readonly<{ id: string }>): void => {
    values.push(id);
  };
}

export function countedDelivery(onDeliver: () => void): () => true {
  return () => {
    onDeliver();
    return true;
  };
}

export function connectedRunnerRealtimeWithDelivery(
  onDeliver: () => void,
  sessionOverrides: RealtimeSessionOverrides = {},
  runnerOverrides: RealtimeRunnerOverrides = {},
) {
  return connectedRunnerRealtimeTestIntegration(
    { ...countedRunnerDelivery(onDeliver), ...sessionOverrides },
    runnerOverrides,
  );
}

function countedRunnerDelivery(
  onDeliver: () => void,
): Readonly<{ deliverRunnerCommands: () => true }> {
  return { deliverRunnerCommands: countedDelivery(onDeliver) };
}

export function expectAuthoritativeHeartbeat(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  authoritative: ReturnType<typeof connectedRecordedRunnerRealtimeTestSocket>,
  seen: () => number,
): void {
  sendRealtimeMessage(realtime.websocket, authoritative.socket, {
    type: "heartbeat",
  });
  expect(authoritative.record.closed).toBeUndefined();
  expect(seen()).toBe(1);
}

export function restartRegistrationAndExpectReplacement(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  failed: ReturnType<typeof connectedRecordedRunnerRealtimeTestSocket>,
  machineId: string,
): void {
  sendRunnerConnectProposal(realtime.websocket, failed.socket, machineId);
  expect(failed.record.closes).toContainEqual([
    1008,
    "Runner connection was replaced",
  ]);
}

export function expectRegistrationChanged(
  connection: ReturnType<typeof connectedRecordedRunnerRealtimeTestSocket>,
  fenced = false,
): void {
  expect(connection.record.closed).toEqual([1008, "Registration changed"]);
  if (fenced) expectFencedRunnerData(connection.socket.data);
}

export function expectFinalizationFailure(
  failed: ReturnType<typeof connectedRecordedRunnerRealtimeTestSocket>,
): void {
  expect(failed.record.closed).toEqual([1011, "Runner finalization failed"]);
}

export function expectNoRunnerEffects(
  data: unknown,
  effects: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): void {
  expectFencedRunnerData(data);
  expect(effects).toEqual(expected);
}

function operationalRegistrationMessages(registrationId: string): string[] {
  return [
    runnerReadyMessage(registrationId, "runner-1"),
    registrationCommittedMessage(registrationId),
    registrationActiveMessage(registrationId),
    registrationFinalizedMessage(registrationId),
    registrationOperationalMessage(registrationId),
  ];
}

export function expectOperationalRegistration(
  messages: readonly string[],
): void {
  expect(messages).toEqual(
    operationalRegistrationMessages(registrationIdFromMessages(messages)),
  );
}

export function recordRecoveryCallbacks(
  recoveries: string[],
  afterRestart?: () => void,
) {
  return {
    runnerConnected: (runnerId: string) => {
      recoveries.push(`ordinary:${runnerId}`);
    },
    runnerRestartReady: (runnerId: string, restartId: string) => {
      recoveries.push(`${runnerId}:${restartId}`);
      afterRestart?.();
    },
  };
}

export function recordedPendingRunnerRestart(
  recoveries: string[],
  restartId: string,
) {
  return {
    pendingRunnerRestart: () => runnerRestartGate(restartId),
    ...recordRecoveryCallbacks(recoveries),
  };
}

export function recordRestartReady(resumed: string[]) {
  return (runnerId: string, restartId: string): void => {
    resumed.push(`${runnerId}:${restartId}`);
  };
}

export function connectedRunnerRecorder(recovered: string[]) {
  return { runnerConnected: recordRunner(recovered) };
}

export function recordRunner(values: string[]) {
  return (runnerId: string): void => {
    values.push(runnerId);
  };
}

export function registrationIdFromMessages(
  messages: readonly string[],
): string {
  const ready = messages
    .map((message): unknown => JSON.parse(message))
    .find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "registration_ready",
    );
  if (
    typeof ready !== "object" ||
    ready === null ||
    !("registrationId" in ready) ||
    typeof ready.registrationId !== "string"
  ) {
    throw new Error("The failed registration receipt was unavailable");
  }
  return ready.registrationId;
}

export function recordRestartId(values: string[]) {
  return (_runnerId: string, restartId: string): void => {
    values.push(restartId);
  };
}

export function runnerCommand(id: string, sessionId: string) {
  return {
    arguments: {},
    executionEnvironment: "bare_metal" as const,
    id,
    sessionId,
    tool: "read" as const,
    workingDirectory: "/work",
  };
}
