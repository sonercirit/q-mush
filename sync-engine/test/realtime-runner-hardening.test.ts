import { expect, test } from "vitest";
import { RUNNER_REALTIME_PATH, RUNNERS_PATH } from "../../shared/routes.ts";
import { RunnerCommandBroker } from "../../shared/runner-command-broker.ts";
import { runnerRegistrationRejectedMessage } from "../../shared/runner-realtime-protocol.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
  createRunnerRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import {
  conflictReconnects,
  connectedRunnerRealtimeWithDelivery,
  emptyRecordedValues,
  expectCount,
  expectNoRunnerEffects,
  expectRejectedConnection,
  expectRejectedSockets,
  expectRestartReady,
  initializedRestartGateTest,
  reconnectRunnerCases,
  recordCommandEffects,
  recordRestartId,
  recordRestartReady,
  recordRunner,
  restartGateScenario,
  restartRecords,
  runnerCommand,
  seenRecorder,
  unsetDurableGate,
} from "./realtime-hardening-helpers.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  realtimeRunnerConnection,
  realtimeRunnerLifecycle,
  realtimeTestSessions,
  recreatedRunnerRealtimeTestIntegration,
  runnerRestartGate,
} from "./realtime-test-helpers.ts";
import {
  acceptRunnerRegistration,
  acknowledgeActiveRunnerRegistration,
  acknowledgeFinalizedRunnerRegistration,
  acknowledgeOperationalRunnerRegistration,
  assertRealtimeUpgrade,
  beginRunnerRestart,
  connectedRecordedRunnerRealtimeTestSocket,
  realtimeTestSocket,
  receiveRunnerRegistration,
  reconnectRunnerRealtimeTestSocket,
  recordedRealtimeTestSocket,
  runnerRealtimeTestSetup,
  runnerRealtimeWithToken,
  sendRealtimeMessage,
  sendRunnerConnect,
  sendRunnerConnectProposal,
} from "./realtime-test-socket-helpers.ts";
import { createQueuedTestRunnerIntegration } from "./runner-integration-test-helpers.ts";

test("rejects conflicting restart and activation receipt identities", () => {
  const { realtime, resumed } = restartGateScenario("restart-exact");
  const { upgrade } = runnerRealtimeTestSetup();
  const rejected = recordedRealtimeTestSocket(upgrade);

  sendRunnerConnectProposal(
    realtime.websocket,
    rejected.socket,
    "machine-conflicting-receipt",
    {
      activationReceipt: "restart-other",
      restartId: "restart-exact",
    },
  );

  expectRejectedConnection(rejected.record.sent, resumed);
});

test("a valid restart receipt cannot override an explicitly conflicting restart ID", () => {
  const { realtime, resumed } = restartGateScenario("restart-receipt-exact");

  const rejected = reconnectRunnerRealtimeTestSocket(
    realtime,
    "machine-receipt-conflict",
    {
      activationReceipt: "test-activation-receipt",
      claimedActivationReceiptPhase: "prepared",
      restartId: "restart-other",
    },
  );

  expectRejectedConnection(rejected.sent, resumed);
});

test("an in-memory restart gate takes precedence over a stale receipt", async () => {
  const resumed: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration({
    runnerRestartReady: recordRestartReady(resumed),
  });
  const original = beginRunnerRestart(
    realtime,
    "machine-stale-receipt",
    "restart-current",
  );
  await expectRestartReady(original, "restart-current");

  const rejected = reconnectRunnerRealtimeTestSocket(
    realtime,
    "machine-stale-receipt",
    { activationReceipt: "restart-stale" },
  );

  expectRejectedConnection(rejected.sent, resumed);

  reconnectRunnerRealtimeTestSocket(realtime, "machine-stale-receipt", {
    restartId: "restart-current",
  });
  expect(resumed).toEqual(["runner-1:restart-current"]);
});

test("an ordinary or mismatched reconnect cannot release a runner restart", async () => {
  const resumed: string[] = [];
  const { realtime, rejected } = await initializedRestartGateTest(resumed, {
    machineId: "machine-mismatch",
    rejectedRestartIds: [undefined, "restart-other"],
    restartId: "restart-exact",
  });

  expect(resumed).toEqual([]);
  expect(rejected).toHaveLength(2);

  reconnectRunnerRealtimeTestSocket(realtime, "machine-mismatch", {
    restartId: "restart-exact",
  });
  expect(resumed).toEqual(["runner-1:restart-exact"]);
});

test("conflicting in-memory and durable restart gates reject every reconnect", async () => {
  const { recovered, resumed } = restartRecords();
  const durableGate = unsetDurableGate();
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: (_runnerId, _processNonce, deliver) =>
      durableGate.restartId === undefined
        ? true
        : deliver(runnerCommand("conflict-command", "session-conflict")),
    pendingRunnerRestart: () =>
      durableGate.restartId === undefined
        ? { status: "none" }
        : runnerRestartGate(durableGate.restartId),
    runnerConnected: recordRunner(recovered),
    runnerRestartReady: recordRestartReady(resumed),
  });
  const original = beginRunnerRestart(
    realtime,
    "machine-conflict",
    "restart-memory",
  );

  await expectRestartReady(original, "restart-memory");

  durableGate.restartId = "restart-durable";
  const rejected = reconnectRunnerCases(realtime, [
    { machineId: "machine-conflict", restartId: "restart-memory" },
    { machineId: "machine-conflict", restartId: "restart-durable" },
    { machineId: "machine-conflict", restartId: undefined },
  ]);

  expectRejectedSockets(rejected);
  expect(recovered).toEqual(["runner-1"]);
  expect(resumed).toEqual([]);
});

test("durable conflict gates reject before registration side effects", () => {
  const { recovered, resumed } = restartRecords();
  let delivered = 0;

  let seen = 0;
  const realtime = connectedRunnerRealtimeWithDelivery(
    () => {
      delivered += 1;
    },
    {
      pendingRunnerRestart: () => ({ status: "conflicted" }),
      runnerConnected: recordRunner(recovered),
      runnerRestartReady: recordRestartReady(resumed),
    },
    seenRecorder(() => {
      seen += 1;
    }),
  );

  const rejected = reconnectRunnerCases(realtime, conflictReconnects);

  expectRejectedSockets(rejected);
  expect(delivered).toBe(0);
  expect(seen).toBe(0);
  emptyRecordedValues(recovered, resumed);
});

test("durable restart gates survive integration recreation", () => {
  const recovered: string[] = [];
  const sessions = realtimeTestSessions({
    pendingRunnerRestart: () => runnerRestartGate("restart-persisted"),
    runnerConnected: (runnerId) => {
      recovered.push(`ordinary:${runnerId}`);
    },
    runnerRestartReady: (runnerId, restartId) => {
      recovered.push(`${runnerId}:${restartId}`);
    },
  });
  const createIntegration = () =>
    recreatedRunnerRealtimeTestIntegration(sessions);

  const rejected = [];
  for (const restartId of [undefined, "restart-other"] as const) {
    rejected.push(
      ...reconnectRunnerCases(createIntegration(), [
        { machineId: "machine-persisted", restartId },
      ]),
    );
  }
  expectRejectedSockets(rejected);
  expect(recovered).toEqual([]);

  reconnectRunnerRealtimeTestSocket(createIntegration(), "machine-persisted", {
    restartId: "restart-persisted",
  });
  expect(recovered).toEqual(["runner-1:restart-persisted"]);
});

test("rejects a reinstallation before rotating its token when a durable restart identity is missing or wrong", async () => {
  const database = createAuthenticatedTestDatabase();
  const ids = ["runner-existing", "runner-pending"];

  const tokens = ["token-existing-setup", "token-pending-setup"];
  const runners = createQueuedTestRunnerIntegration(database, ids, tokens);
  const createSetup = async (): Promise<string> => {
    const response = runners.collection(
      createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
    );
    const setup: unknown = await response.json();
    if (
      typeof setup !== "object" ||
      setup === null ||
      !("setup" in setup) ||
      typeof setup.setup !== "object" ||
      setup.setup === null ||
      !("downloadUrl" in setup.setup) ||
      typeof setup.setup.downloadUrl !== "string"
    ) {
      throw new Error("The runner setup response was invalid");
    }
    const token = new URL(
      setup.setup.downloadUrl,
      "http://localhost",
    ).searchParams.get("token");
    if (token === null) {
      throw new Error("The runner setup token was unavailable");
    }
    return token;
  };
  const tokenA = await createSetup();
  const tokenB = await createSetup();
  expect(
    runners.connect(tokenA, {
      architecture: "x64",
      machineFingerprint: "machine-reinstall",
      name: "original",
      platform: "linux",
    })?.connection.id,
  ).toBe("runner-existing");
  for (const restartId of [undefined, "restart-wrong"] as const) {
    const presenceEffects = { delivered: 0, resumed: 0 };
    const { realtime, upgrade } = runnerRealtimeWithToken(runners, tokenB, {
      deliverRunnerCommands: () => {
        presenceEffects.delivered += 1;
        return true;
      },
      pendingRunnerRestart: () => runnerRestartGate("restart-exact"),
      runnerConnected: () => {
        presenceEffects.resumed += 1;
      },
      runnerRestartReady: () => {
        presenceEffects.resumed += 1;
      },
    });

    const socket = realtimeTestSocket(upgrade());
    sendRunnerConnect(
      realtime.websocket,
      socket,
      "machine-reinstall",
      restartId,
    );

    expect(socket.sent).toEqual([runnerRegistrationRejectedMessage()]);
    expect(presenceEffects).toEqual({ delivered: 0, resumed: 0 });
    expect(
      runners.runnerToken(createRunnerRequest(RUNNER_REALTIME_PATH, tokenA)),
    ).toBe(tokenA);
    expect(
      runners.runnerToken(createRunnerRequest(RUNNER_REALTIME_PATH, tokenB)),
    ).toBe(tokenB);
    expect(runners.listForUser(TEST_USER_ID)).toMatchObject([
      { id: "runner-existing", name: "original", status: "online" },
      { id: "runner-pending", status: "pending" },
    ]);
  }

  database.$client.close();
});

test("queued command delivery failure fences the replacement and preserves restart release", () => {
  const disconnected: string[] = [];
  const { recovered, resumed } = restartRecords();
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: (_runnerId, _processNonce, deliver) =>
      deliver(runnerCommand("queued-command", "session-1")),
    pendingRunnerRestart: () => runnerRestartGate("restart-delivery"),
    ...realtimeRunnerLifecycle({
      connected: recovered,
      disconnected,
    }),
    runnerRestartReady: recordRestartId(resumed),
  });
  const failed = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-delivery",
    {
      failure: "zero",
      restartId: "restart-delivery",
      successfulSendsBeforeFailure: 5,
    },
  );

  expect(failed.record.closed).toEqual([
    1011,
    "Runner command delivery failed",
  ]);
  expect(disconnected).toEqual([]);
  expect(resumed).toEqual(["restart-delivery"]);
  expect(recovered).toEqual([]);
  const retry = reconnectRunnerRealtimeTestSocket(
    realtime,
    "machine-delivery-retry",
    {
      activationReceipt: "test-activation-receipt",
      restartId: "restart-delivery",
    },
  );
  expect(retry.sent).toHaveLength(6);
  expect(retry.sent).toContain(
    JSON.stringify({
      command: runnerCommand("queued-command", "session-1"),
      type: "command",
    }),
  );
  expect(resumed).toEqual(["restart-delivery"]);
});

test("a registration metadata race after active delivery fails closed", () => {
  let activationAllowed = true;
  let delivered = 0;

  const connected: string[] = [];
  const realtime = connectedRunnerRealtimeWithDelivery(
    () => {
      delivered += 1;
    },
    { runnerConnected: recordRunner(connected) },
    {
      preflightRegistration: () => {
        const selected = realtimeRunnerConnection();
        return {
          activationId: "test-activation-id",
          prepare: () => ({
            activationReceipt: "test-activation-receipt",
            connected: selected,
            status: "registered",
          }),
          finalize: () =>
            activationAllowed
              ? {
                  connected: selected,
                  status: "activated",
                }
              : { status: "registration_changed" },
          runnerId: selected.connection.id,
        };
      },
    },
  );

  const pending = recordedRealtimeTestSocket(
    assertRealtimeUpgrade(realtime, RUNNER_REALTIME_PATH),
  );

  sendRunnerConnectProposal(
    realtime.websocket,
    pending.socket,
    "machine-metadata-race",
  );
  acceptRunnerRegistration(realtime.websocket, pending.socket);

  receiveRunnerRegistration(realtime.websocket, pending.socket);
  activationAllowed = false;
  acknowledgeActiveRunnerRegistration(realtime.websocket, pending.socket);

  expect(pending.record.closed).toEqual([1008, "Registration changed"]);

  expectNoRunnerEffects(
    pending.socket.data,
    { connected, delivered },
    { connected: [], delivered: 0 },
  );
});

test("queued commands remain hidden until activation", () => {
  let deliveries = 0;
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: () => {
      deliveries += 1;
      return true;
    },
  });
  const { upgrade } = runnerRealtimeTestSetup();
  const pending = recordedRealtimeTestSocket(upgrade);

  sendRunnerConnectProposal(
    realtime.websocket,
    pending.socket,
    "machine-pending",
  );
  expectCount(deliveries, 0);
  acceptRunnerRegistration(realtime.websocket, pending.socket);
  expectCount(deliveries, 0);
  for (let resend = 0; resend < 2; resend += 1) {
    receiveRunnerRegistration(realtime.websocket, pending.socket);

    expectCount(deliveries, 0);
    expect(pending.socket.data).toMatchObject({
      runner: undefined,
      usable: false,
    });
  }

  acknowledgeActiveRunnerRegistration(realtime.websocket, pending.socket);
  expectCount(deliveries, 0);

  acknowledgeFinalizedRunnerRegistration(realtime.websocket, pending.socket);
  expectCount(deliveries, 0);
  acknowledgeOperationalRunnerRegistration(realtime.websocket, pending.socket);
  expect(deliveries).toBe(1);
});

test("fresh process nonce fails disconnected commands before queued delivery", async () => {
  const delivered: string[] = [];
  const rejected: unknown[] = [];
  const broker = new RunnerCommandBroker({
    commandId: () => "fresh-process-command",
    deliver: () => true,
  });
  broker.registerRunnerProcess("runner-1", "process-old");
  const result = broker.dispatch({
    arguments: {},
    executionEnvironment: "bare_metal",
    runnerId: "runner-1",
    sessionId: "session-fresh-process",
    tool: "read",
    workingDirectory: "/workspace",
  });
  void result.catch((error: unknown) => {
    rejected.push(error);
  });
  broker.disconnectRunner("runner-1");
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: (
      runnerId,
      processNonce,
      deliver,
      _deliverCancellation,
      generation,
    ) => {
      broker.registerRunnerProcess(runnerId, processNonce);
      broker.deliverQueued(
        runnerId,
        (command) => {
          delivered.push(command.id);
          return deliver(command);
        },
        generation,
      );
      return true;
    },
  });

  connectedRecordedRunnerRealtimeTestSocket(realtime, "machine-fresh-process", {
    processNonce: "process-fresh",
  });
  await result.catch(() => undefined);

  expect(delivered).toEqual([]);
  expect(rejected).toEqual([
    expect.objectContaining({
      message: "The runner process restarted before the command returned",
      name: "RunnerDisconnectedError",
    }),
  ]);
});

test("thrown queued delivery rolls authority back to the previous socket", () => {
  let throwDelivery = false;
  const realtime = connectedRunnerRealtimeTestIntegration({
    deliverRunnerCommands: () => {
      if (throwDelivery) {
        throw new Error("delivery unavailable");
      }
      return true;
    },
  });
  const previous = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-rollback-previous",
  );
  throwDelivery = true;
  const replacement = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-rollback-replacement",
  );

  expect(replacement.record.closed).toEqual([
    1011,
    "Runner command delivery failed",
  ]);
  expect(previous.record.closed).toBeUndefined();
  expect(previous.socket.data).toMatchObject({ usable: true });
  sendRealtimeMessage(realtime.websocket, previous.socket, {
    type: "heartbeat",
  });
  expect(previous.record.closes).toEqual([]);
});

test("replacing an authoritative socket does not disconnect the shared runner", () => {
  const disconnected: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration({
    runnerDisconnected: recordRunner(disconnected),
  });
  const replaced = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-replaced-authority",
  );

  reconnectRunnerRealtimeTestSocket(realtime, "machine-new-authority");

  expect(replaced.record.sent).toContain(
    JSON.stringify({ type: "superseded" }),
  );
  expect(replaced.record.closed).toEqual([
    4001,
    "Superseded by a newer runner process",
  ]);
  expect(disconnected).toEqual([]);
});

test("a replaced runner socket has no inbound authority", () => {
  const completed: string[] = [];
  const drained: string[] = [];
  let seen = 0;
  const realtime = connectedRunnerRealtimeTestIntegration(
    recordCommandEffects(completed, drained),
    seenRecorder(() => {
      seen += 1;
    }),
  );
  const stale = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-stale",
  );
  reconnectRunnerRealtimeTestSocket(realtime, "machine-current");
  const seenAfterReplacement = seen;

  for (const event of [
    { type: "heartbeat" },
    { commandId: "stale-command", output: "stale", type: "result" },
    { restartId: "stale-restart", type: "restart" },
  ] as const) {
    sendRealtimeMessage(realtime.websocket, stale.socket, event);
  }

  expect(stale.record.closes).toContainEqual([
    1008,
    "Runner connection was replaced",
  ]);
  expect(seen).toBe(seenAfterReplacement);
  expect(completed).toEqual([]);
  expect(drained).toEqual([]);
});
