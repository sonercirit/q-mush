import { expect } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import {
  encodeRunnerActivationReceipt,
  runnerConnectMessage,
  runnerRegistrationAcceptMessage,
  runnerRegistrationActiveReceivedMessage,
  runnerRegistrationFinalizedReceivedMessage,
  runnerRegistrationOperationalReceivedMessage,
  runnerRegistrationReceivedMessage,
} from "../../shared/runner-realtime-protocol.ts";
import type {
  createRealtimeIntegration,
  QmushWebSocketData,
} from "../../sync-engine/realtime.ts";
import type { RunnerIntegration } from "../../sync-engine/runners.ts";
import { createRunnerRequest } from "./authenticated-integration-test-helpers.ts";
import { userRealtimeCommand } from "./realtime-command-fixtures.ts";
import {
  openRealtimeSocket,
  realtimeSocketMessage,
  sendRealtimeMessage,
} from "./realtime-handler-fixtures.ts";
import {
  configuredRealtimeTestIntegration,
  connectedRunnerRealtimeTestIntegration,
  realtimeTestSessions,
  RealtimeUpgradeServer,
  type RealtimeRunnerOverrides,
  type RealtimeSessionOverrides,
} from "./realtime-test-helpers.ts";

export interface RealtimeTestSocket {
  readonly data: QmushWebSocketData;
  close(code?: number, reason?: string): void;
  publish(): number;
  send(message: string): number;
  subscribe(): void;
  unsubscribe(): void;
}

interface RunnerRealtimeTestSetup {
  readonly realtime: ReturnType<typeof createRealtimeIntegration>;
  readonly upgrade: Extract<QmushWebSocketData, { kind: "runner" }>;
}

type RunnerSocket = RealtimeTestSocket & { readonly sent: string[] };

interface RunnerRealtimeWithTokenSetup {
  readonly realtime: ReturnType<typeof createRealtimeIntegration>;
  readonly upgrade: () => Extract<QmushWebSocketData, { kind: "runner" }>;
}

export function upgradeRunnerWithToken(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  token: string,
): Extract<QmushWebSocketData, { kind: "runner" }> {
  const request = createRunnerRequest(RUNNER_REALTIME_PATH, token);
  request.headers.set("upgrade", "websocket");
  const server = new RealtimeUpgradeServer();
  expect(realtime.upgrade(request, server)).toBeUndefined();
  if (server.data?.kind !== "runner") {
    throw new Error("The runner token did not upgrade a runner socket");
  }
  return server.data;
}

export function runnerRealtimeWithToken(
  runners: RunnerIntegration,
  token: string,
  sessionOverrides: RealtimeSessionOverrides = {},
): RunnerRealtimeWithTokenSetup {
  const realtime = configuredRealtimeTestIntegration({
    runners,
    sessions: realtimeTestSessions(sessionOverrides),
  });
  return {
    realtime,
    upgrade: () => upgradeRunnerWithToken(realtime, token),
  };
}

export function runnerRealtimeTestSetup(
  sessionOverrides: RealtimeSessionOverrides = {},
  runnerOverrides: RealtimeRunnerOverrides = {},
): RunnerRealtimeTestSetup {
  const realtime = connectedRunnerRealtimeTestIntegration(
    sessionOverrides,
    runnerOverrides,
  );
  const upgrade = assertRealtimeUpgrade(realtime, RUNNER_REALTIME_PATH);
  if (upgrade.kind !== "runner") {
    throw new Error("The runner realtime test request had user data");
  }
  return { realtime, upgrade };
}

export type RunnerConnectOptions = Readonly<{
  activationReceipt?: string;
  /** A caller claim retained only to prove it is not encoded on the wire. */
  claimedActivationReceiptPhase?: "finalized" | "prepared";
  processNonce?: string;
  restartId?: string;
}>;

export function optionalRunnerRestartId(
  restartId: string | undefined,
): RunnerConnectOptions {
  return restartId === undefined ? {} : { restartId };
}

interface RunnerReconnectOptions extends RunnerConnectOptions {
  readonly beforeConnect?: (socket: RunnerSocket) => void;
}

type FinalizedRunnerReconnectOptions = Omit<
  RunnerReconnectOptions,
  "activationReceipt"
>;

function finalizedReconnectOptions(
  options: FinalizedRunnerReconnectOptions,
  claimedActivationReceiptPhase?: "finalized" | "prepared",
): RunnerReconnectOptions {
  return {
    ...options,
    activationReceipt: "test-activation-receipt",
    ...(claimedActivationReceiptPhase === undefined
      ? {}
      : { claimedActivationReceiptPhase }),
  };
}

function reconnectWithFinalizedReceipt(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  options: FinalizedRunnerReconnectOptions,
  claimedActivationReceiptPhase?: "finalized" | "prepared",
): RunnerSocket {
  return reconnectRunnerRealtimeTestSocket(
    realtime,
    machineId,
    finalizedReconnectOptions(options, claimedActivationReceiptPhase),
  );
}

export function finalizedRunnerActivationReceipts(): Set<string> {
  return new Set(["test-activation-receipt"]);
}

export function reconnectRunnerWithFinalizedReceipt(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  options: FinalizedRunnerReconnectOptions = {},
  claimedActivationReceiptPhase?: "finalized" | "prepared",
): RunnerSocket {
  return reconnectWithFinalizedReceipt(
    realtime,
    machineId,
    options,
    claimedActivationReceiptPhase,
  );
}

export function reconnectFinalizedRunnerPair(
  setup: Readonly<{
    realtime: ReturnType<typeof createRealtimeIntegration>;
    machineId: string;
  }>,
  options: FinalizedRunnerReconnectOptions = {},
  afterFirst?: (first: RunnerSocket) => void,
): Readonly<{ first: RunnerSocket; retry: RunnerSocket }> {
  const { machineId, realtime } = setup;
  const first = reconnectRunnerWithFinalizedReceipt(realtime, machineId, {
    ...options,
  });
  afterFirst?.(first);
  return {
    first,
    retry: reconnectRunnerWithFinalizedReceipt(realtime, machineId, options),
  };
}

export function reconnectRunnerRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  options: RunnerReconnectOptions = {},
): RunnerSocket {
  const socket = upgradeRunnerRealtimeTestSocket(realtime);
  options.beforeConnect?.(socket);
  sendRunnerConnect(
    realtime.websocket,
    socket,
    machineId,
    options.restartId,
    true,
    options.activationReceipt,
    options.claimedActivationReceiptPhase,
    options.processNonce,
  );
  return socket;
}

export function beginRunnerRestart(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  restartId: string,
  beforeRestart?: (socket: RunnerSocket) => void,
): RunnerSocket {
  const socket = reconnectRunnerRealtimeTestSocket(realtime, machineId);
  beforeRestart?.(socket);
  sendRunnerRestart(realtime.websocket, socket, restartId);
  return socket;
}

export function realtimeTestUpgrade(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
  server: RealtimeUpgradeServer,
  websocket = true,
): Response | undefined {
  return realtime.upgrade(
    new Request(
      new URL(path, "http://localhost").pathname === "/api/realtime"
        ? `http://localhost${path.includes("?") ? path : `${path}?workspaceId=workspace-1`}`
        : `http://localhost${path}`,
      {
        headers: {
          ...(new URL(path, "http://localhost").pathname === "/api/realtime"
            ? { origin: "http://localhost" }
            : {}),
          ...(websocket ? { upgrade: "websocket" } : {}),
        },
      },
    ),
    server,
  );
}

interface RealtimeTestSocketOptions {
  readonly close?: (code?: number, reason?: string) => void;
  readonly send?: (message: string) => number;
}

export function realtimeTestSocket(
  data: QmushWebSocketData | undefined,
  options: RealtimeTestSocketOptions = {},
): RealtimeTestSocket & { readonly sent: string[] } {
  if (data === undefined) {
    throw new Error("The test WebSocket did not upgrade");
  }
  const sent: string[] = [];
  return {
    close: options.close ?? (() => undefined),
    data,
    publish: () => 1,
    send:
      options.send ??
      ((message) => {
        sent.push(message);
        return 1;
      }),
    sent,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  };
}

export type RealtimeSendFailure = "throw" | "zero";

interface RealtimeSocketRecord {
  closed: readonly [number | undefined, string | undefined] | undefined;
  readonly closes: (readonly [number | undefined, string | undefined])[];
  readonly sent: string[];
}

interface RecordedRealtimeTestSocketOptions {
  readonly failure?: RealtimeSendFailure;
  readonly successfulSendsBeforeFailure?: number;
}

export function recordedRealtimeTestSocket(
  data: QmushWebSocketData | undefined,
  options: RecordedRealtimeTestSocketOptions = {},
): Readonly<{
  record: RealtimeSocketRecord;
  socket: RealtimeTestSocket;
}> {
  const record: RealtimeSocketRecord = {
    closed: undefined,
    closes: [],
    sent: [],
  };
  let attempts = 0;
  const socket = realtimeTestSocket(data, {
    close: (code, reason) => {
      record.closed = [code, reason];
      record.closes.push([code, reason]);
    },
    send: (message) => {
      attempts += 1;
      if (
        options.failure !== undefined &&
        attempts === (options.successfulSendsBeforeFailure ?? 0) + 1
      ) {
        if (options.failure === "throw") {
          throw new Error("send failed");
        }
        return 0;
      }
      record.sent.push(message);
      return 1;
    },
  });
  return { record, socket };
}

interface ConnectedRecordedRunnerOptions
  extends RecordedRealtimeTestSocketOptions, RunnerConnectOptions {}

function runnerRegistrationId(socket: RealtimeTestSocket): string | undefined {
  return socket.data.kind === "runner"
    ? socket.data.registration?.registrationId
    : undefined;
}

function finishRunnerRegistration(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  socket: RealtimeTestSocket,
): void {
  const registrationId = runnerRegistrationId(socket);
  if (registrationId === undefined || socket.data.kind !== "runner") return;
  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerRegistrationAcceptMessage(registrationId),
  );
  if (socket.data.committed?.registrationId !== registrationId) {
    return;
  }
  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerRegistrationReceivedMessage(registrationId),
  );
  const registrationAfterReceipt: unknown = socket.data.registration;
  if (
    !isRecord(registrationAfterReceipt) ||
    registrationAfterReceipt["activeSent"] !== true
  ) {
    return;
  }
  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerRegistrationActiveReceivedMessage(registrationId),
  );
  const afterFinalization: unknown = socket.data.registration;
  if (
    !isRecord(afterFinalization) ||
    typeof afterFinalization["finalizedReceipt"] !== "string"
  ) {
    return;
  }
  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerRegistrationFinalizedReceivedMessage(registrationId),
  );
  const afterOperational: unknown = socket.data.registration;
  if (
    !isRecord(afterOperational) ||
    afterOperational["operationalSent"] !== true
  ) {
    return;
  }
  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerRegistrationOperationalReceivedMessage(registrationId),
  );
}

export function connectedRecordedRunnerRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  options: ConnectedRecordedRunnerOptions = {},
): ReturnType<typeof recordedRealtimeTestSocket> {
  const upgraded = upgradeRunnerRealtimeTestSocket(realtime);
  const connection = recordedRealtimeTestSocket(upgraded.data, options);
  sendRunnerConnect(
    realtime.websocket,
    connection.socket,
    machineId,
    options.restartId,
    false,
    options.activationReceipt,
    options.claimedActivationReceiptPhase,
    options.processNonce,
  );
  finishRunnerRegistration(realtime, connection.socket);
  return connection;
}

function upgradeRecordedRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
  options: RecordedRealtimeTestSocketOptions = {},
): ReturnType<typeof recordedRealtimeTestSocket> {
  const upgraded = upgradeRealtimeTestSocket(realtime, path);
  return recordedRealtimeTestSocket(upgraded.data, options);
}

export function openUserRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
): ReturnType<typeof recordedRealtimeTestSocket> {
  const connection = upgradeRecordedRealtimeTestSocket(
    realtime,
    "/api/realtime?workspaceId=workspace-1",
  );
  openRealtimeSocket(realtime.websocket, connection.socket);
  connection.record.sent.length = 0;
  return connection;
}

export function assertRealtimeUpgrade(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
): QmushWebSocketData {
  const server = new RealtimeUpgradeServer();
  expect(realtimeTestUpgrade(realtime, path, server)).toBeUndefined();
  if (server.data === undefined) {
    throw new Error("The realtime test request did not upgrade");
  }
  return server.data;
}

function upgradeRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  path: string,
): RealtimeTestSocket & { readonly sent: string[] } {
  return realtimeTestSocket(assertRealtimeUpgrade(realtime, path));
}

function upgradeRunnerRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
): RealtimeTestSocket & { readonly sent: string[] } {
  return upgradeRealtimeTestSocket(realtime, RUNNER_REALTIME_PATH);
}

export function proposedRunnerRealtimeTestSocket(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  options: RunnerConnectOptions = {},
  data = assertRealtimeUpgrade(realtime, RUNNER_REALTIME_PATH),
): ReturnType<typeof recordedRealtimeTestSocket> {
  const pending = recordedRealtimeTestSocket(data);
  sendRunnerConnectProposal(
    realtime.websocket,
    pending.socket,
    machineId,
    options,
  );
  return pending;
}

export function sendRunnerConnectProposal(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  machineId: string,
  options: RunnerConnectOptions = {},
): unknown {
  const encodedReceipt =
    options.activationReceipt === undefined
      ? undefined
      : encodeRunnerActivationReceipt({
          value: options.activationReceipt,
        });
  const encodedOptions = {
    ...(encodedReceipt === undefined
      ? {}
      : { activationReceipt: encodedReceipt }),
    ...optionalRunnerRestartId(options.restartId),
  };
  return realtimeSocketMessage(
    handler,
    socket,
    runnerConnectMessage(
      {
        architecture: "x64",
        machineId,
        name: "runner",
        platform: "linux",
      },
      encodedOptions,
    ),
  );
}

function registrationId(
  socket: RealtimeTestSocket,
  unavailable: string,
): string {
  const available = runnerRegistrationId(socket);
  if (available === undefined) throw new Error(unavailable);
  return available;
}

function sendRegistrationAcknowledgement(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  unavailable: string,
  message: (registrationId: string) => string,
): unknown {
  return realtimeSocketMessage(
    handler,
    socket,
    message(registrationId(socket, unavailable)),
  );
}

type RegistrationAcknowledgement = (
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
) => unknown;

function registrationAcknowledgement(
  unavailable: string,
  message: (registrationId: string) => string,
): RegistrationAcknowledgement {
  return (handler, socket) =>
    sendRegistrationAcknowledgement(handler, socket, unavailable, message);
}

export const acceptRunnerRegistration = registrationAcknowledgement(
  "The runner registration proposal is unavailable",
  runnerRegistrationAcceptMessage,
);

export const receiveRunnerRegistration = registrationAcknowledgement(
  "The committed runner registration is unavailable",
  runnerRegistrationReceivedMessage,
);

export const acknowledgeActiveRunnerRegistration = registrationAcknowledgement(
  "The active runner registration is unavailable",
  runnerRegistrationActiveReceivedMessage,
);

export const acknowledgeFinalizedRunnerRegistration =
  registrationAcknowledgement(
    "The finalized runner registration is unavailable",
    runnerRegistrationFinalizedReceivedMessage,
  );

export const acknowledgeOperationalRunnerRegistration =
  registrationAcknowledgement(
    "The operational runner registration is unavailable",
    runnerRegistrationOperationalReceivedMessage,
  );

export function receivePendingRunnerRegistration(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  connection: ReturnType<typeof recordedRealtimeTestSocket>,
): void {
  acceptRunnerRegistration(realtime.websocket, connection.socket);
  receiveRunnerRegistration(realtime.websocket, connection.socket);
}

export function finishPendingRunnerRegistration(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  connection: ReturnType<typeof recordedRealtimeTestSocket>,
  beforeActiveAcknowledgement?: () => void,
): void {
  receivePendingRunnerRegistration(realtime, connection);
  beforeActiveAcknowledgement?.();
  acknowledgeActiveRunnerRegistration(realtime.websocket, connection.socket);
}

export function sendRunnerConnect(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  machineId: string,
  restartId?: string,
  finish = true,
  activationReceipt?: string,
  claimedActivationReceiptPhase: "finalized" | "prepared" = "finalized",
  processNonce?: string,
): unknown {
  const connected = sendRunnerConnectProposal(handler, socket, machineId, {
    ...(activationReceipt === undefined
      ? {}
      : { activationReceipt, claimedActivationReceiptPhase }),
    ...optionalRunnerRestartId(restartId),
    ...(processNonce === undefined ? {} : { processNonce }),
  });

  if (
    !finish ||
    socket.data.kind !== "runner" ||
    socket.data.registration === undefined
  ) {
    return connected;
  }
  const registrationId = socket.data.registration.registrationId;
  realtimeSocketMessage(
    handler,
    socket,
    runnerRegistrationAcceptMessage(registrationId),
  );
  realtimeSocketMessage(
    handler,
    socket,
    runnerRegistrationReceivedMessage(registrationId),
  );
  realtimeSocketMessage(
    handler,
    socket,
    runnerRegistrationActiveReceivedMessage(registrationId),
  );
  realtimeSocketMessage(
    handler,
    socket,
    runnerRegistrationFinalizedReceivedMessage(registrationId),
  );
  return realtimeSocketMessage(
    handler,
    socket,
    runnerRegistrationOperationalReceivedMessage(registrationId),
  );
}

export function sendRunnerRestart(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  restartId: string,
): unknown {
  return sendRealtimeMessage(handler, socket, { restartId, type: "restart" });
}

export function sendUserRealtimeCommand(
  handler: Bun.WebSocketHandler<QmushWebSocketData>,
  socket: RealtimeTestSocket,
  command: Parameters<typeof userRealtimeCommand>,
): unknown {
  return sendRealtimeMessage(handler, socket, userRealtimeCommand(...command));
}

export {
  closeRealtimeSocket,
  openRealtimeSocket,
  sendRealtimeMessage,
} from "./realtime-handler-fixtures.ts";
export {
  parseRealtimeMessages,
  registrationActiveMessage,
  registrationCommittedMessage,
  registrationFinalizedMessage,
  registrationOperationalMessage,
  runnerReadyMessage,
  runnerRestartReadyMessage,
  waitForRealtimeEvent,
  waitForRealtimeTasks,
} from "./realtime-message-fixtures.ts";
