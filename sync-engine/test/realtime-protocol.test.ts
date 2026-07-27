import { expect, test } from "vitest";
import {
  encodeRunnerActivationReceipt,
  runnerConnectMessage,
  runnerRegistrationAcceptMessage,
  runnerRegistrationActiveReceivedMessage,
  runnerRegistrationFinalizedReceivedMessage,
  runnerRegistrationOperationalReceivedMessage,
  runnerRegistrationReceivedMessage,
} from "../../shared/runner-realtime-protocol.ts";
import {
  readRunnerClientMessage,
  readRunnerConnectMessage,
  readRunnerRegistrationMessage,
} from "../../sync-engine/realtime-protocol.ts";

function testRunnerMetadata() {
  return {
    architecture: "x64",
    machineId: "machine-id",
    name: "runner",
    platform: "linux",
  };
}

function expectInvalid(
  read: (value: string) => unknown,
  value: string,
  message: string,
): void {
  expect(() => read(value)).toThrow(message);
}

function runnerClientMessage(value: object) {
  return readRunnerClientMessage(JSON.stringify(value));
}

function expectInvalidRunnerClientMessage(value: object): void {
  expectInvalid(
    readRunnerClientMessage,
    JSON.stringify(value),
    "WebSocket message was invalid",
  );
}

function expectInvalidConnectMessage(message: string): void {
  expectInvalid(
    readRunnerConnectMessage,
    message,
    "connection message was invalid",
  );
}

function expectRoundTripClientMessage(message: object): void {
  expect(runnerClientMessage(message)).toEqual(message);
}

test("reads an optional exact restart identity from runner registration", () => {
  const metadata = testRunnerMetadata();
  const connectMessage = (restartId?: string): string =>
    runnerConnectMessage(
      metadata,
      restartId === undefined ? {} : { restartId },
    );
  expect(readRunnerConnectMessage(connectMessage())).toEqual({
    ...metadata,
    type: "connect",
  });
  expect(readRunnerConnectMessage(connectMessage("restart-1"))).toEqual({
    ...metadata,
    restartId: "restart-1",
    type: "connect",
  });
});

test("validates optional activation receipts and exact connect shape", () => {
  const metadata = testRunnerMetadata();
  expect(
    readRunnerConnectMessage(
      runnerConnectMessage(metadata, {
        activationReceipt: encodeRunnerActivationReceipt({
          value: "activation-1",
        }),
        restartId: "restart-1",
      }),
    ),
  ).toEqual({
    activationReceipt: { value: "activation-1" },
    ...metadata,
    restartId: "restart-1",
    type: "connect",
  });
  expect(() =>
    readRunnerConnectMessage(
      JSON.stringify({ ...metadata, extra: true, type: "connect" }),
    ),
  ).toThrow("connection message was invalid");
  const invalidActivationReceipts = ["", "x".repeat(201)];
  invalidActivationReceipts.forEach((activationReceipt) => {
    expectInvalidConnectMessage(
      runnerConnectMessage(metadata, { activationReceipt }),
    );
  });
});

test("reads and strictly validates registration acknowledgements", () => {
  expect(
    readRunnerRegistrationMessage(
      runnerRegistrationAcceptMessage("registration-1"),
    ),
  ).toEqual({
    registrationId: "registration-1",
    type: "registration_accept",
  });
  expect(
    readRunnerRegistrationMessage(
      runnerRegistrationActiveReceivedMessage("registration-1"),
    ),
  ).toEqual({
    registrationId: "registration-1",
    type: "registration_active_received",
  });
  expect(
    readRunnerRegistrationMessage(
      runnerRegistrationFinalizedReceivedMessage("registration-1"),
    ),
  ).toEqual({
    registrationId: "registration-1",
    type: "registration_finalized_received",
  });
  expect(
    readRunnerRegistrationMessage(
      runnerRegistrationOperationalReceivedMessage("registration-1"),
    ),
  ).toEqual({
    registrationId: "registration-1",
    type: "registration_operational_received",
  });
  expect(
    readRunnerRegistrationMessage(
      runnerRegistrationReceivedMessage("registration-1"),
    ),
  ).toEqual({
    registrationId: "registration-1",
    type: "registration_received",
  });
  for (const invalid of [
    { registrationId: "", type: "registration_accept" },
    {
      extra: true,
      registrationId: "registration-1",
      type: "registration_accept",
    },
    { registrationId: "registration-1", type: "registration_unknown" },
  ]) {
    expectInvalid(
      readRunnerRegistrationMessage,
      JSON.stringify(invalid),
      "registration message was invalid",
    );
  }
});

test("reads bounded output deltas and explicit final result states", () => {
  expectRoundTripClientMessage({
    channel: "stderr",
    commandId: "command-1",
    content: "warning",
    sequence: 3,
    type: "output",
  });
  expectRoundTripClientMessage({
    commandId: "command-1",
    output: "failed output",
    state: "failed",
    type: "result",
  });

  expectInvalidRunnerClientMessage({
    channel: "stdout",
    commandId: "command-1",
    content: "gap",
    sequence: -1,
    type: "output",
  });
  expectInvalidRunnerClientMessage({
    commandId: "command-1",
    output: "legacy result",
    type: "result",
  });
});

test("rejects invalid restart identities on connect and restart messages", () => {
  const metadata = testRunnerMetadata();

  const invalidRestartIds = ["", "x".repeat(201)];
  invalidRestartIds.forEach((restartId) => {
    expectInvalidConnectMessage(runnerConnectMessage(metadata, { restartId }));
    expectInvalidRunnerClientMessage({ restartId, type: "restart" });
  });
});
