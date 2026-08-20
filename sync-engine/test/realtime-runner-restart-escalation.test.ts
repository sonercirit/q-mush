import { expect, test } from "vitest";
import {
  createRecordedRunnerEffects,
  expectOperationalRegistration,
} from "./realtime-hardening-helpers.ts";
import {
  connectedRestartRealtime,
  recordedRestartIds,
} from "./realtime-runner-restart-fixtures.ts";
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
  const replacementState = new Map<string, RealtimeTestSocket>();
  const { finalizedReceipts, realtime } = connectedRestartRealtime({
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
      const replacement = replacementState.get("current");
      effects.resumed.push(`${runnerId}:${restartId}`);
      usableAtResume.push(
        replacement?.data.kind === "runner" && replacement.data.usable,
      );
    },
  });
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
      replacementState.set("current", socket);
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

test("a disconnected pre-ack restart reconnects with the same identity and escalates", async () => {
  const pending = Promise.withResolvers<undefined>();
  const escalation = recordedRestartIds();
  const { finalizedReceipts, realtime } = connectedRestartRealtime({
    drainRunner: () => pending.promise,
    escalateRunnerDrain: escalation.record,
  });
  const first = beginRunnerRestart(
    realtime,
    "machine-pre-ack",
    "restart-pre-ack",
  );
  finalizedReceipts.clear();
  const replacement = reconnectRunnerRealtimeTestSocket(
    realtime,
    "machine-pre-ack",
    { restartId: "restart-pre-ack" },
  );
  closeRealtimeSocket(realtime.websocket, first);
  expect(replacement.sent.length).toBeGreaterThan(0);
  expect(replacement.data.kind === "runner" && replacement.data.usable).toBe(
    true,
  );
  expect(first.data.kind === "runner" && first.data.usable).toBe(false);
  sendRealtimeMessage(realtime.websocket, replacement, {
    restartId: "restart-pre-ack",
    type: "restart_escalate",
  });

  await Promise.resolve();
  expect(escalation.ids).toEqual(["restart-pre-ack"]);
  pending.resolve(undefined);
  await Promise.resolve();
  expect(replacement.sent).toContain(
    runnerRestartReadyMessage("restart-pre-ack"),
  );
});

test("a runner restart escalation frame uses the dedicated drain escalation boundary", async () => {
  const drains: string[] = [];
  const escalation = recordedRestartIds();
  const pending = Promise.withResolvers<undefined>();
  const { realtime } = connectedRestartRealtime({
    drainRunner: (_runnerId, restartId) => {
      drains.push(restartId);
      return pending.promise;
    },
    escalateRunnerDrain: escalation.record,
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

  expect(drains).toEqual(["restart-escalation"]);
  expect(escalation.ids).toEqual(["restart-escalation"]);
  pending.resolve(undefined);
  await Promise.resolve();
});
