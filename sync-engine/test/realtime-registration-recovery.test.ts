import { expect, test } from "vitest";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import {
  connectedRunnerRecorder,
  expectCommittedRegistrationFailure,
  expectOperationalRegistration,
  failedCommittedRegistration,
  finalizedRunnerRealtimeTestIntegration,
  recordRecoveryCallbacks,
  recordedPendingRunnerRestart,
  registrationIdFromMessages,
} from "./realtime-hardening-helpers.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  realtimeRunnerConnection,
  realtimeTestSessions,
  recreatedRunnerRealtimeTestIntegration,
  runnerRestartGate,
} from "./realtime-test-helpers.ts";
import {
  acceptRunnerRegistration,
  assertRealtimeUpgrade,
  closeRealtimeSocket,
  finalizedRunnerActivationReceipts,
  proposedRunnerRealtimeTestSocket,
  receivePendingRunnerRegistration,
  reconnectFinalizedRunnerPair,
  reconnectRunnerRealtimeTestSocket,
  reconnectRunnerWithFinalizedReceipt,
  recordedRealtimeTestSocket,
  registrationActiveMessage,
  registrationFinalizedMessage,
  registrationOperationalMessage,
  sendRunnerConnectProposal,
} from "./realtime-test-socket-helpers.ts";

const committedRegistrationFailures = ["zero", "throw"] as const;

function preparedReceiptRetry(
  realtime: ReturnType<typeof connectedRunnerRealtimeTestIntegration>,
  machineId: string,
) {
  return reconnectRunnerWithFinalizedReceipt(
    realtime,
    machineId,
    {},
    "prepared",
  );
}

test("a lost positive activation acknowledgement retries without duplicate durable release", () => {
  const releasedRestart = { value: false };
  const recoveries: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration({
    pendingRunnerRestart: () =>
      releasedRestart.value
        ? { status: "none" }
        : runnerRestartGate("restart-activation-retry"),
    ...recordRecoveryCallbacks(recoveries, () => {
      releasedRestart.value = true;
    }),
  });
  const original = recordedRealtimeTestSocket(
    assertRealtimeUpgrade(realtime, RUNNER_REALTIME_PATH),
  );
  sendRunnerConnectProposal(
    realtime.websocket,
    original.socket,
    "machine-activation-retry",
    { restartId: "restart-activation-retry" },
  );
  receivePendingRunnerRegistration(realtime, original);
  const registrationId = registrationIdFromMessages(original.record.sent);

  expect(original.record.sent).toContain(
    registrationActiveMessage(registrationId),
  );
  expect(
    original.record.sent.includes(registrationFinalizedMessage(registrationId)),
  ).toBe(false);
  expect(
    original.record.sent.includes(
      registrationOperationalMessage(registrationId),
    ),
  ).toBe(false);
  expect(recoveries).toEqual([]);
  closeRealtimeSocket(realtime.websocket, original.socket);
  const { first: firstRetry, retry } = reconnectFinalizedRunnerPair(
    { machineId: "machine-activation-retry", realtime },
    { restartId: "restart-activation-retry" },
    (first) => {
      closeRealtimeSocket(realtime.websocket, first);
    },
  );

  expect(recoveries).toEqual(["runner-1:restart-activation-retry"]);
  for (const socket of [firstRetry, retry]) {
    expectOperationalRegistration(socket.sent);
  }
});

test("accepts a prepared receipt without a restart gate", () => {
  const recovered: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration(
    connectedRunnerRecorder(recovered),
  );
  expect(recovered).toEqual([]);

  const retry = preparedReceiptRetry(
    realtime,
    "machine-prepared-without-restart",
  );

  expect(retry.sent).toHaveLength(5);
  expect(recovered).toEqual(["runner-1"]);
});

test("treats client receipt phase hints as non-authoritative", () => {
  const realtime = finalizedRunnerRealtimeTestIntegration();

  const retry = preparedReceiptRetry(
    realtime,
    "machine-finalized-client-prepared",
  );

  expect(retry.sent).toHaveLength(5);
});

test("a finalized replay revalidates and touches without preflight or prepare", () => {
  let preflightCalls = 0;
  let touchCalls = 0;
  const realtime = finalizedRunnerRealtimeTestIntegration(
    {},
    {
      preflightRegistration: () => {
        preflightCalls += 1;
        return undefined;
      },
      touchFinalizedActivation: (token, metadata, receipt) => {
        touchCalls += 1;
        expect({ metadata, receipt, token }).toMatchObject({
          metadata: { machineFingerprint: "machine-finalization-race" },
          receipt: "test-activation-receipt",
          token: "qmr_runner-token",
        });
        return realtimeRunnerConnection();
      },
    },
  );

  const pending = proposedRunnerRealtimeTestSocket(
    realtime,
    "machine-finalization-race",
    {
      activationReceipt: "test-activation-receipt",
      claimedActivationReceiptPhase: "prepared",
    },
  );
  acceptRunnerRegistration(realtime.websocket, pending.socket);

  expect(pending.record.closed).toBeUndefined();
  expect(preflightCalls).toBe(0);
  expect(touchCalls).toBe(1);
});

test("a durably finalized receipt retries a lost final frame idempotently", () => {
  const recovered: string[] = [];
  const realtime = finalizedRunnerRealtimeTestIntegration(
    connectedRunnerRecorder(recovered),
  );

  const retry = reconnectRunnerWithFinalizedReceipt(
    realtime,
    "machine-finalized-prepared-retry",
  );

  expect(recovered).toEqual(["runner-1"]);
  expectOperationalRegistration(retry.sent);
});

test("a finalized restart receipt releases a remaining durable gate without another activation", () => {
  let activations = 0;

  let pending = true;
  const recoveries: string[] = [];
  const realtime = finalizedRunnerRealtimeTestIntegration(
    {
      pendingRunnerRestart: () =>
        pending
          ? runnerRestartGate("restart-finalized-retry")
          : { status: "none" },
      runnerRestartReady: (runnerId, restartId) => {
        recoveries.push(`${runnerId}:${restartId}`);
        pending = false;
      },
    },
    {
      preflightRegistration: () => {
        const connected = realtimeRunnerConnection();
        return {
          activationId: "test-activation-id",
          finalize: () => {
            activations += 1;
            return {
              connected,
              status: "activated",
            };
          },
          prepare: () => ({
            activationReceipt: "test-activation-receipt",
            connected,
            status: "registered",
          }),
          runnerId: connected.connection.id,
        };
      },
    },
    { lifecycle: "restart", restartId: "restart-finalized-retry" },
  );

  const retry = reconnectRunnerWithFinalizedReceipt(
    realtime,
    "machine-finalized-restart",
    { restartId: "restart-finalized-retry" },
    "prepared",
  );

  expect(activations).toBe(0);
  expect(recoveries).toEqual(["runner-1:restart-finalized-retry"]);
  expectOperationalRegistration(retry.sent);
});

test("rejects a finalized retry whose exact restart scope no longer matches", () => {
  const recoveries: string[] = [];
  const realtime = finalizedRunnerRealtimeTestIntegration(
    recordRecoveryCallbacks(recoveries),
  );

  const retry = reconnectRunnerWithFinalizedReceipt(
    realtime,
    "machine-finalized-released",
    { restartId: "restart-already-released" },
    "prepared",
  );

  expect(recoveries).toEqual([]);
  expect(retry.sent).toEqual([]);
});

test("a prepared activation receipt retries the required durable release", () => {
  const recoveries: string[] = [];
  const realtime = connectedRunnerRealtimeTestIntegration(
    recordedPendingRunnerRestart(recoveries, "restart-prepared-retry"),
  );

  const retry = reconnectRunnerWithFinalizedReceipt(
    realtime,
    "machine-prepared-retry",
    { restartId: "restart-prepared-retry" },
    "prepared",
  );

  expect(retry.sent).toEqual([]);
  expect(recoveries).toEqual([]);
});

test("a durable restart receipt is released after integration recreation", () => {
  const recoveries: string[] = [];
  const sessions = realtimeTestSessions(
    recordedPendingRunnerRestart(recoveries, "restart-recreated-receipt"),
  );
  const recreated = recreatedRunnerRealtimeTestIntegration(
    sessions,
    finalizedRunnerActivationReceipts(),
    { lifecycle: "restart", restartId: "restart-recreated-receipt" },
  );

  const retry = reconnectRunnerWithFinalizedReceipt(
    recreated,
    "machine-recreated-receipt",
    { restartId: "restart-recreated-receipt" },
  );

  expect(recoveries).toEqual(["runner-1:restart-recreated-receipt"]);
  expectOperationalRegistration(retry.sent);
});

test.each(committedRegistrationFailures)(
  "a lost final restart commitment retains the durable handoff for an exact retry after recreation (%s)",
  (failure) => {
    let pending = true;
    const recoveries: string[] = [];
    const sessionIntegration = () =>
      realtimeTestSessions({
        pendingRunnerRestart: () =>
          pending ? runnerRestartGate("restart-commit") : { status: "none" },
        ...recordRecoveryCallbacks(recoveries),
      });
    const integration = (sessions = sessionIntegration()) =>
      recreatedRunnerRealtimeTestIntegration(sessions);
    const failedIntegration = integration();
    const failed = failedCommittedRegistration(
      failedIntegration,
      "machine-commit-restart",
      failure,
      "restart-commit",
    );

    expectCommittedRegistrationFailure(failed);
    expect(recoveries).toEqual([]);

    const recreated = integration();
    const mismatched = reconnectRunnerRealtimeTestSocket(
      recreated,
      "machine-commit-restart",
      { restartId: "restart-other" },
    );
    expect(mismatched.sent).toEqual([]);

    const retry = reconnectRunnerRealtimeTestSocket(
      recreated,
      "machine-commit-restart",
      { restartId: "restart-commit" },
    );
    expect(recoveries).toEqual(["runner-1:restart-commit"]);
    expectOperationalRegistration(retry.sent);

    pending = false;
    const committedRecreation = integration();
    const ordinary = reconnectRunnerRealtimeTestSocket(
      committedRecreation,
      "machine-commit-restart",
    );
    expect(ordinary.sent).toHaveLength(5);
    expect(recoveries).toEqual([
      "runner-1:restart-commit",
      "ordinary:runner-1",
    ]);
  },
);
