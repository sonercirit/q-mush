import { expect, test } from "vitest";
import {
  RunnerCommandBroker,
  type RunnerCommandResult,
} from "../../shared/runner-command-broker.ts";
import { captureBrokerRejection } from "../../shared/test/promise-test-helpers.ts";
import { connectedRunnerRealtimeTestIntegration } from "./realtime-test-helpers.ts";
import {
  closeRealtimeSocket,
  connectedRecordedRunnerRealtimeTestSocket,
  sendRealtimeMessage,
} from "./realtime-test-socket-helpers.ts";

const RUNNER_ID = "runner-1";
const PROCESS_A = "runner-process-a";

function commandInput(sessionId: string) {
  return {
    arguments: {},
    executionEnvironment: "bare_metal" as const,
    runnerId: RUNNER_ID,
    sessionId,
    tool: "read",
    workingDirectory: "/workspace",
  };
}

function completed(output: string): RunnerCommandResult {
  return { output, state: "completed" };
}

function frameTypes(messages: readonly string[]): string[] {
  return messages.map((message) => {
    const value: unknown = JSON.parse(message);
    return typeof value === "object" &&
      value !== null &&
      "type" in value &&
      typeof value.type === "string"
      ? value.type
      : "unknown";
  });
}

function expectFrame(
  messages: readonly string[],
  type: string,
  present = true,
): void {
  if (present) {
    expect(frameTypes(messages)).toContain(type);
  } else {
    expect(frameTypes(messages)).not.toContain(type);
  }
}

function expectCanceled(value: unknown): void {
  expect(value).toHaveProperty("name", "AbortError");
}

function brokerRealtime(broker: RunnerCommandBroker) {
  return connectedRunnerRealtimeTestIntegration({
    acknowledgeRunnerCancellation: (runnerId, commandId) =>
      broker.acknowledgeCancellation(runnerId, commandId),
    commitRunnerProcess: (runnerId, processNonce) => {
      broker.commitRunnerProcess(runnerId, processNonce);
    },
    completeRunnerCommand: (runnerId, commandId, result) =>
      broker.complete(runnerId, commandId, result),
    deliverRunnerCommands: ({
      connectionGeneration,
      deliver,
      deliverCancellation,
      processNonce,
      runnerId,
    }) =>
      broker.deliverRunnerCommands(
        runnerId,
        processNonce,
        deliver,
        deliverCancellation,
        connectionGeneration,
      ),
  });
}

function tombstonedCommand(commandId: string): Readonly<{
  broker: RunnerCommandBroker;
  rejection: Promise<unknown>;
}> {
  const broker = new RunnerCommandBroker({
    commandId: () => commandId,
  });
  broker.registerRunnerProcess(RUNNER_ID, PROCESS_A);
  const result = broker.dispatch(commandInput(`session-${commandId}`));
  const dispatched = broker.take(RUNNER_ID);
  if (dispatched?.id !== commandId) throw new Error("Command unavailable");
  const rejection = captureBrokerRejection(result);
  broker.disconnectRunner(RUNNER_ID);
  broker.cancelSessionCommands(`session-${commandId}`);
  return { broker, rejection };
}

test("failed fresh-process delivery rolls authority and survival state back together", async () => {
  const commandIds = [
    "canceled-on-process-a",
    "surviving-on-process-a",
    "in-flight-on-process-a",
    "newly-queued-command",
  ];
  let acceptImmediateDelivery = true;
  const broker = new RunnerCommandBroker({
    commandId: () => {
      const commandId = commandIds.shift();
      if (commandId === undefined) throw new Error("Missing command ID");
      return commandId;
    },
    deliver: () => acceptImmediateDelivery,
  });
  const realtime = brokerRealtime(broker);
  const previous = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-process-a",
    { processNonce: PROCESS_A },
  );

  const canceled = broker.dispatch({
    ...commandInput("session-canceled"),
    workingDirectory: "/workspace/canceled",
  });
  const canceledRejection = captureBrokerRejection(canceled);
  const surviving = broker.dispatch(commandInput("session-surviving"));
  broker.disconnectRunner(RUNNER_ID);
  broker.cancelSessionCommands("session-canceled");
  const inFlight = broker.dispatch(commandInput("session-in-flight"));
  acceptImmediateDelivery = false;
  const newlyQueued = broker.dispatch(commandInput("session-newly-queued"));

  const failed = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-process-b",
    {
      failure: "zero",
      processNonce: "runner-process-b",
      successfulSendsBeforeFailure: 5,
    },
  );

  expect(failed.record.closed?.join(":")).toBe(
    "1011:Runner command delivery failed",
  );
  expect(frameTypes(failed.record.sent)).toEqual([
    "registration_ready",
    "registration_committed",
    "registration_active",
    "registration_finalized",
    "registration_operational",
  ]);
  expect(previous.record.closed === undefined).toBe(true);
  expect(previous.socket.data).toHaveProperty("runner.id", RUNNER_ID);
  expect(previous.socket.data).toHaveProperty("usable", true);
  expect(broker.isActive(RUNNER_ID, "surviving-on-process-a")).toBe(true);
  expect(broker.sessionCommandPhase("session-surviving")).toBe(
    "runner_disconnected",
  );
  expect(
    broker.complete(
      RUNNER_ID,
      "in-flight-on-process-a",
      completed("old authority remained valid"),
    ),
  ).toBe(true);
  await expect(inFlight).resolves.toEqual(
    completed("old authority remained valid"),
  );

  const recovered = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-process-a-reconnected",
    { processNonce: PROCESS_A },
  );
  const recoveredTypes = frameTypes(recovered.record.sent);
  expect(recoveredTypes.indexOf("cancel")).toBeGreaterThanOrEqual(0);
  expect(recoveredTypes.indexOf("command")).toBeGreaterThan(
    recoveredTypes.indexOf("cancel"),
  );
  expect(
    recovered.record.sent.some(
      (message) =>
        message.includes("surviving-on-process-a") ||
        message.includes("newly-queued-command"),
    ),
  ).toBe(true);

  expectCanceled(await canceledRejection);
  expect(
    broker.complete(RUNNER_ID, "surviving-on-process-a", completed("survived")),
  ).toBe(true);
  expect(broker.isActive(RUNNER_ID, "newly-queued-command")).toBe(true);
  expect(
    broker.complete(RUNNER_ID, "newly-queued-command", completed("queued")),
  ).toBe(true);
  await expect(surviving).resolves.toEqual(completed("survived"));
  await expect(newlyQueued).resolves.toEqual(completed("queued"));
});

test("cancellation frames precede surviving queued command frames on the wire", async () => {
  const commandIds = ["wire-canceled", "wire-surviving"];
  const broker = new RunnerCommandBroker({
    commandId: () => commandIds.shift() ?? "unexpected-command",
    deliver: () => true,
  });
  broker.registerRunnerProcess(RUNNER_ID, PROCESS_A);
  const canceled = broker.dispatch(commandInput("session-wire-canceled"));
  const canceledRejection = captureBrokerRejection(canceled);
  const surviving = broker.dispatch(commandInput("session-wire-surviving"));
  broker.disconnectRunner(RUNNER_ID);
  broker.cancelSessionCommands("session-wire-canceled");

  const connected = connectedRecordedRunnerRealtimeTestSocket(
    brokerRealtime(broker),
    "machine-wire-order",
    { processNonce: PROCESS_A },
  );
  const types = frameTypes(connected.record.sent);

  expect(types.indexOf("cancel")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("command")).toBeGreaterThan(types.indexOf("cancel"));
  expectCanceled(await canceledRejection);
  expect(broker.complete(RUNNER_ID, "wire-surviving", completed("done"))).toBe(
    true,
  );
  await expect(surviving).resolves.toEqual(completed("done"));
});

test("a disconnect before cancellation acknowledgement redelivers the tombstone", async () => {
  const { broker, rejection } = tombstonedCommand("cancel-redelivery");
  const realtime = brokerRealtime(broker);
  const first = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-cancel-first",
    { processNonce: PROCESS_A },
  );
  expectFrame(first.record.sent, "cancel");

  closeRealtimeSocket(realtime.websocket, first.socket);
  const second = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-cancel-second",
    { processNonce: PROCESS_A },
  );
  expectFrame(second.record.sent, "cancel");

  sendRealtimeMessage(realtime.websocket, second.socket, {
    commandId: "cancel-redelivery",
    type: "cancellation_received",
  });
  const third = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-cancel-third",
    { processNonce: PROCESS_A },
  );
  expectFrame(third.record.sent, "cancel", false);
  expectCanceled(await rejection);
});

test("a late result racing a cancellation tombstone converges through both acknowledgements", async () => {
  const { broker, rejection } = tombstonedCommand("result-cancel-race");
  const realtime = brokerRealtime(broker);
  const connected = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-result-cancel-race",
    { processNonce: PROCESS_A },
  );
  expectFrame(connected.record.sent, "cancel");

  sendRealtimeMessage(realtime.websocket, connected.socket, {
    commandId: "result-cancel-race",
    output: "late result",
    state: "completed",
    type: "result",
  });
  expect(connected.record.sent.at(-1)).toBe(
    JSON.stringify({
      commandId: "result-cancel-race",
      type: "result_received",
    }),
  );
  sendRealtimeMessage(realtime.websocket, connected.socket, {
    commandId: "result-cancel-race",
    type: "cancellation_received",
  });

  const reconnected = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-result-cancel-race-reconnected",
    { processNonce: PROCESS_A },
  );
  expectFrame(reconnected.record.sent, "cancel", false);
  expectCanceled(await rejection);
});
