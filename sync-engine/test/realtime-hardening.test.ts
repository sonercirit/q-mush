import { expect, test } from "vitest";
import type { AuthenticatedUser } from "../../shared/auth-model.ts";
import type { GoogleAuth } from "../../sync-engine/auth.ts";
import type { createRealtimeIntegration } from "../../sync-engine/realtime.ts";
import {
  countedDelivery,
  createRecordedRunnerEffects,
  expectAuthoritativeHeartbeat,
  expectCommittedRegistrationFailure,
  expectFinalizationFailure,
  expectNoRunnerEffects,
  failedCommittedRegistration,
  failedFinalizedRegistration,
  recordDisconnected,
  recordRestartReady,
  recordRunner,
  registrationIdFromMessages,
  restartRegistrationAndExpectReplacement,
} from "./realtime-hardening-helpers.ts";
import {
  configuredRealtimeTestIntegration,
  connectedRunnerRealtimeTestIntegration,
  createRealtimeUpgradeServer,
  REALTIME_TEST_USER,
  realtimeRunnerLifecycle,
  realtimeTestAuth,
} from "./realtime-test-helpers.ts";
import {
  connectedRecordedRunnerRealtimeTestSocket,
  openRealtimeSocket,
  reconnectRunnerRealtimeTestSocket,
  recordedRealtimeTestSocket,
  registrationActiveMessage,
  registrationCommittedMessage,
  registrationFinalizedMessage,
  registrationOperationalMessage,
  runnerReadyMessage,
  runnerRealtimeTestSetup,
  sendRunnerConnect,
  sendRunnerRestart,
  waitForRealtimeTasks,
  type RealtimeSendFailure,
} from "./realtime-test-socket-helpers.ts";

const committedRegistrationFailures = ["zero", "throw"] as const;

function authorityHeartbeatScenario(
  options: Readonly<{
    disconnected?: (runner: Readonly<{ id: string }>) => void;
  }> = {},
) {
  let seen = 0;
  const realtime = connectedRunnerRealtimeTestIntegration(
    {},
    {
      ...options,
      seen: () => {
        seen += 1;
      },
    },
  );
  return { realtime, seen: () => seen };
}

export function failedOperationalRegistration(
  realtime: ReturnType<typeof createRealtimeIntegration>,
  machineId: string,
  failure: RealtimeSendFailure,
) {
  return connectedRecordedRunnerRealtimeTestSocket(realtime, machineId, {
    failure,
    successfulSendsBeforeFailure: 4,
  });
}

test.each(["zero", "throw"] as const)(
  "fences without lifecycle side effects when its proposal send returns %s",
  (failure) => {
    const disconnected: string[] = [];
    const sessionDisconnects: string[] = [];
    const { realtime, upgrade } = runnerRealtimeTestSetup(
      {
        runnerDisconnected: (runnerId) => {
          sessionDisconnects.push(runnerId);
        },
      },
      {
        disconnected: ({ id }) => {
          disconnected.push(id);
        },
      },
    );
    const connection = recordedRealtimeTestSocket(upgrade, { failure });
    sendRunnerConnect(realtime.websocket, connection.socket, "machine-ready");

    expect(connection.record.closed).toEqual([
      1011,
      "Runner registration proposal failed",
    ]);
    expect(sessionDisconnects).toEqual([]);
    expect(disconnected).toEqual([]);
  },
);

interface RestartSendFailureCase {
  readonly failure: RealtimeSendFailure;
  readonly label: string;
}

const restartSendFailures: readonly RestartSendFailureCase[] = [
  { failure: "zero", label: "returns zero" },
  { failure: "throw", label: "throws" },
];

test.each(restartSendFailures)(
  "retains restart state after acknowledgement send $label and replays every same-ID retry",
  async ({ failure }) => {
    let drainCalls = 0;
    const reported: string[] = [];
    const realtime = connectedRunnerRealtimeTestIntegration({
      drainRunner: () => {
        drainCalls += 1;
        return Promise.resolve();
      },
      runnerRestartReady: recordRestartReady(reported),
    });
    const failed = connectedRecordedRunnerRealtimeTestSocket(
      realtime,
      "machine-restart",
      { failure, successfulSendsBeforeFailure: 5 },
    );
    sendRunnerRestart(realtime.websocket, failed.socket, "restart-send");
    await Promise.resolve();

    expect(failed.record.closed).toEqual([
      1011,
      "Runner restart acknowledgement failed",
    ]);
    expect(reported).toEqual([]);

    const oldSocketReplacement = reconnectRunnerRealtimeTestSocket(
      realtime,
      "machine-restart-replacement",
    );
    oldSocketReplacement.sent.length = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      sendRunnerRestart(
        realtime.websocket,
        oldSocketReplacement,
        "restart-send",
      );
      await waitForRealtimeTasks();
    }

    expect(drainCalls).toBe(1);
    expect(oldSocketReplacement.sent).toEqual([]);
    expect(reported).toEqual([]);

    reconnectRunnerRealtimeTestSocket(realtime, "machine-restart-replacement", {
      restartId: "restart-send",
    });

    expect(drainCalls).toBe(1);
    expect(reported).toEqual(["runner-1:restart-send"]);
  },
);

test.each(committedRegistrationFailures)(
  "fences a runner when its committed-registration send returns %s",
  (failure) => {
    const recovered: string[] = [];
    let presence = 0;
    const realtime = connectedRunnerRealtimeTestIntegration(
      {
        runnerConnected: recordRunner(recovered),
      },
      {
        seen: () => {
          presence += 1;
        },
      },
    );
    const failed = failedCommittedRegistration(
      realtime,
      "machine-commit",
      failure,
    );

    expectCommittedRegistrationFailure(failed);
    expect(failed.socket.data).toMatchObject({ usable: false });
    expect(presence).toBe(0);
    expect(recovered).toEqual([]);
  },
);

test.each(committedRegistrationFailures)(
  "fences without operational authority when its finalized-registration send returns %s",
  (failure) => {
    const effects = createRecordedRunnerEffects();
    let delivered = 0;
    const realtime = connectedRunnerRealtimeTestIntegration(
      {
        deliverRunnerCommands: countedDelivery(() => {
          delivered += 1;
        }),
        ...realtimeRunnerLifecycle(effects),
      },
      { disconnected: recordDisconnected(effects.presence) },
    );

    const failed = failedFinalizedRegistration(
      { realtime },
      "machine-finalized-send",
      failure,
    );

    expectFinalizationFailure(failed);
    expectNoRunnerEffects(
      failed.socket.data,
      { ...effects, delivered },
      {
        connected: [],
        delivered: 0,
        disconnected: [],
        presence: [],
        resumed: [],
      },
    );
  },
);

test.each(committedRegistrationFailures)(
  "keeps the old socket authoritative when a replacement finalization send returns %s",
  (failure) => {
    const presence: string[] = [];
    const authority = authorityHeartbeatScenario({
      disconnected: recordDisconnected(presence),
    });
    const realtime = authority.realtime;
    const authoritative = connectedRecordedRunnerRealtimeTestSocket(
      realtime,
      "machine-authoritative",
    );
    const failed = failedFinalizedRegistration(
      { realtime },
      "machine-replacement-failed",
      failure,
    );

    expectFinalizationFailure(failed);
    expect(presence).toEqual([]);
    expectAuthoritativeHeartbeat(realtime, authoritative, authority.seen);
  },
);

test.each(committedRegistrationFailures)(
  "returns a durably finalized retry offline when its final frame returns %s without authority",
  (failure) => {
    const presence: string[] = [];
    const realtime = connectedRunnerRealtimeTestIntegration(
      {},
      { disconnected: recordDisconnected(presence) },
      new Set(["test-activation-receipt"]),
    );
    const failed = connectedRecordedRunnerRealtimeTestSocket(
      realtime,
      "machine-finalized-retry-failed",
      {
        activationReceipt: "test-activation-receipt",
        claimedActivationReceiptPhase: "prepared",
        failure,
        successfulSendsBeforeFailure: 3,
      },
    );

    expectFinalizationFailure(failed);
    expect(presence).toEqual([]);
  },
);

test.each(committedRegistrationFailures)(
  "keeps the old socket authoritative when a replacement operational frame returns %s",
  (failure) => {
    const authority = authorityHeartbeatScenario();
    const realtime = authority.realtime;
    const authoritative = connectedRecordedRunnerRealtimeTestSocket(
      realtime,
      "machine-authoritative-operational",
    );
    const failed = failedOperationalRegistration(
      realtime,
      "machine-replacement-operational-failed",
      failure,
    );

    expect(failed.record.closed).toEqual([
      1011,
      "Runner operational transition failed",
    ]);

    expectAuthoritativeHeartbeat(realtime, authoritative, authority.seen);
  },
);

test("cannot restart a registration after commitment delivery fails", () => {
  const realtime = connectedRunnerRealtimeTestIntegration();
  const failed = connectedRecordedRunnerRealtimeTestSocket(
    realtime,
    "machine-commit-restart-on-socket",
    { failure: "zero", successfulSendsBeforeFailure: 1 },
  );

  restartRegistrationAndExpectReplacement(
    realtime,
    failed,
    "machine-commit-restart-on-socket",
  );
});

test.each(committedRegistrationFailures)(
  "cannot restart a registration after its final frame returns %s",
  (failure) => {
    const realtime = connectedRunnerRealtimeTestIntegration();
    const failed = failedFinalizedRegistration(
      { realtime },
      "machine-final-restart-on-socket",
      failure,
    );

    restartRegistrationAndExpectReplacement(
      realtime,
      failed,
      "machine-final-restart-on-socket",
    );
  },
);

test.each(committedRegistrationFailures)(
  "retries a committed registration after its commitment send returns %s",
  (failure) => {
    const recovered: string[] = [];
    const realtime = connectedRunnerRealtimeTestIntegration({
      runnerConnected: recordRunner(recovered),
    });
    const failed = failedCommittedRegistration(
      realtime,
      "machine-commit-retry",
      failure,
    );
    expectCommittedRegistrationFailure(failed);
    const retry = reconnectRunnerRealtimeTestSocket(
      realtime,
      "machine-commit-retry",
    );

    const retryRegistrationId = registrationIdFromMessages(retry.sent);
    expect(recovered).toEqual(["runner-1"]);
    expect(retry.sent).toEqual([
      runnerReadyMessage(retryRegistrationId, "runner-1"),
      registrationCommittedMessage(retryRegistrationId),
      registrationActiveMessage(retryRegistrationId),
      registrationFinalizedMessage(retryRegistrationId),
      registrationOperationalMessage(retryRegistrationId),
    ]);
  },
);

function passiveAuth(valid: () => boolean): GoogleAuth {
  const user: AuthenticatedUser = REALTIME_TEST_USER;
  return {
    ...realtimeTestAuth(user),
    revalidateUser: (_request, expectedUserId) =>
      valid() && expectedUserId === user.id ? user : null,
  };
}

test("revokes a passive browser socket when its session expires", () => {
  const callbacks = new Map<number, () => void>();
  const cleared: number[] = [];
  let nextTimer = 0;
  let valid = true;
  const realtime = configuredRealtimeTestIntegration({
    auth: passiveAuth(() => valid),
    authRevalidationIntervalMs: 1,
    clearInterval: (id) => {
      cleared.push(id);
      callbacks.delete(id);
    },
    setInterval: (callback) => {
      nextTimer += 1;
      callbacks.set(nextTimer, callback);
      return nextTimer;
    },
  });
  const server = createRealtimeUpgradeServer();
  expect(
    realtime.upgrade(
      new Request("http://localhost/api/realtime?workspaceId=workspace-1", {
        headers: { origin: "http://localhost", upgrade: "websocket" },
      }),
      server,
    ),
  ).toBeUndefined();
  const connection = recordedRealtimeTestSocket(server.data);
  openRealtimeSocket(realtime.websocket, connection.socket);

  valid = false;
  const revalidate = callbacks.get(1);
  revalidate?.();

  const expectedClose = [1008, "Authentication expired"] as const;
  expect({
    cleared,
    closed: connection.record.closed,
  }).toEqual({ cleared: [1], closed: expectedClose });
});
