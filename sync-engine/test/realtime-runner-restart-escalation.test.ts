import { expect, test } from "vitest";
import {
  createRecordedRunnerEffects,
  expectOperationalRegistration,
} from "./realtime-hardening-helpers.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  REALTIME_TEST_USER,
  realtimeRunnerConnection,
} from "./realtime-test-helpers.ts";
import {
  beginRunnerRestart,
  closeRealtimeSocket,
  reconnectRunnerRealtimeTestSocket,
  runnerRestartReadyMessage,
  sendRealtimeMessage,
  type RealtimeTestSocket,
} from "./realtime-test-socket-helpers.ts";

test("retains restart state until replacement confirmation", async () => {
  let drainCalls = 0;
  let finishDrain: (() => void) | undefined;
  const effects = createRecordedRunnerEffects();
  const usableAtResume: boolean[] = [];
  const replacementState: { socket?: RealtimeTestSocket } = {};
  const finalizedReceipts = new Set<string>();
  const realtime = connectedRunnerRealtimeTestIntegration(
    {
      drainRunner: () => {
        drainCalls += 1;
        return new Promise<void>((resolve) => {
          finishDrain = resolve;
        });
      },
      runnerConnected: (runnerId) => {
        effects.connected.push(runnerId);
      },
      runnerDisconnected: (runnerId) => {
        effects.disconnected.push(runnerId);
      },
      runnerRestartReady: (runnerId, restartId) => {
        const replacement = replacementState.socket;
        effects.resumed.push(`${runnerId}:${restartId}`);
        usableAtResume.push(
          replacement?.data.kind === "runner" && replacement.data.usable,
        );
      },
    },
    {
      connect: () =>
        realtimeRunnerConnection("runner-1", REALTIME_TEST_USER.id),
    },
    finalizedReceipts,
  );
  const first = beginRunnerRestart(
    realtime,
    "machine-1",
    "restart-reconnect",
    (socket) => {
      socket.sent.length = 0;
    },
  );

  finishDrain?.();
  await Promise.resolve();
  expect(first.sent).toEqual([runnerRestartReadyMessage("restart-reconnect")]);
  expect(effects.resumed).toEqual([]);

  closeRealtimeSocket(realtime.websocket, first);
  finalizedReceipts.clear();
  const replacement = reconnectRunnerRealtimeTestSocket(realtime, "machine-1", {
    beforeConnect: (socket) => {
      replacementState.socket = socket;
    },
    restartId: "restart-reconnect",
  });

  expect({
    connected: effects.connected,
    disconnected: effects.disconnected,
    drainCalls,
    resumed: effects.resumed,
    usableAtResume,
  }).toEqual({
    connected: ["runner-1"],
    disconnected: ["runner-1"],
    drainCalls: 1,
    resumed: ["runner-1:restart-reconnect"],
    usableAtResume: [false],
  });
  expectOperationalRegistration(replacement.sent);
});

test("a runner restart escalation frame re-enters the production drain boundary", async () => {
  const drains: string[] = [];
  const pending = Promise.withResolvers<undefined>();
  const realtime = connectedRunnerRealtimeTestIntegration({
    drainRunner: (_runnerId, restartId) => {
      drains.push(restartId);
      return pending.promise;
    },
  });
  const socket = beginRunnerRestart(
    realtime,
    "machine-escalation",
    "restart-escalation",
  );

  sendRealtimeMessage(realtime.websocket, socket, {
    restartId: "restart-escalation",
    type: "restart_escalate",
  });

  expect(drains).toEqual(["restart-escalation", "restart-escalation"]);
  pending.resolve(undefined);
  await Promise.resolve();
});
