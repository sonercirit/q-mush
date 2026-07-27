import { expect, test } from "vitest";
import {
  expectFencedRunnerData,
  expectRegistrationChanged,
  expectRetrySequence,
  finalizedRunnerRealtimeTestIntegration,
  recordRunner,
} from "./realtime-hardening-helpers.ts";
import {
  connectedRunnerRealtimeTestIntegration,
  proposedRunnerRealtimeTestIntegration,
  realtimeRunnerConnection,
  realtimeRunnerReceiptState,
} from "./realtime-test-helpers.ts";
import {
  acknowledgeFinalizedRunnerRegistration,
  acknowledgeOperationalRunnerRegistration,
  finishPendingRunnerRegistration,
  proposedRunnerRealtimeTestSocket,
  reconnectFinalizedRunnerPair,
} from "./realtime-test-socket-helpers.ts";

function pendingRegistration(
  realtime: ReturnType<typeof connectedRunnerRealtimeTestIntegration>,
  machineId: string,
  activationReceipt?: string,
) {
  return proposedRunnerRealtimeTestSocket(realtime, machineId, {
    ...(activationReceipt === undefined ? {} : { activationReceipt }),
  });
}

test("rejects prepared activation when proposal finalization changes", () => {
  let activationAllowed = true;
  const realtime = proposedRunnerRealtimeTestIntegration(() =>
    activationAllowed
      ? {
          connected: realtimeRunnerConnection(),
          status: "activated",
        }
      : { status: "registration_changed" },
  );
  const pending = pendingRegistration(
    realtime,
    "machine-prepared-finalization-race",
    "test-activation-receipt",
  );
  finishPendingRunnerRegistration(realtime, pending, () => {
    activationAllowed = false;
  });

  expectRegistrationChanged(pending, true);
});

test("rejects prepared activation without durable finalized classification", () => {
  let returnPrepared = false;
  let receiptReads = 0;
  let admissionReceiptRead = true;
  const realtime = connectedRunnerRealtimeTestIntegration(
    {},
    {
      receiptState: (_token, _metadata, receipt) => {
        receiptReads += 1;
        if (admissionReceiptRead) {
          admissionReceiptRead = false;
          return undefined;
        }
        return receipt === "test-activation-receipt"
          ? realtimeRunnerReceiptState({
              phase: returnPrepared ? "prepared" : "finalized",
            })
          : undefined;
      },
    },
  );
  const pending = pendingRegistration(
    realtime,
    "machine-prepared-durable-race",
  );
  finishPendingRunnerRegistration(realtime, pending, () => {
    returnPrepared = true;
  });

  expect(receiptReads).toBe(1);
  expectRegistrationChanged(pending, true);
});

test("rejects prepared activation whose lifecycle was already settled", () => {
  let admissionReceiptRead = true;

  let finalizeCalls = 0;
  const realtime = proposedRunnerRealtimeTestIntegration(
    () => {
      finalizeCalls += 1;
      return {
        connected: realtimeRunnerConnection(),
        status: "activated",
      };
    },
    {
      receiptState: () => {
        if (admissionReceiptRead) {
          admissionReceiptRead = false;
          return undefined;
        }
        return realtimeRunnerReceiptState({ lifecycleSettled: true });
      },
    },
  );
  const pending = pendingRegistration(realtime, "machine-already-settled-race");
  finishPendingRunnerRegistration(realtime, pending);

  expect(finalizeCalls).toBe(1);
  expectRegistrationChanged(pending);
});

test("fences when durable finalized state changes before lifecycle settlement", () => {
  let receiptReads = 0;
  const realtime = finalizedRunnerRealtimeTestIntegration(
    {},
    {
      receiptState: () => {
        receiptReads += 1;
        return receiptReads < 3 ? realtimeRunnerReceiptState() : undefined;
      },
    },
  );
  const pending = pendingRegistration(
    realtime,
    "machine-finalization-race-after-touch",
    "test-activation-receipt",
  );

  finishPendingRunnerRegistration(realtime, pending);
  acknowledgeFinalizedRunnerRegistration(realtime.websocket, pending.socket);

  expect(receiptReads).toBe(3);
  expect(pending.record.closed).toEqual([
    1011,
    "Runner lifecycle settlement failed",
  ]);
  expectFencedRunnerData(pending.socket.data);
});

test("contains lifecycle callback failures and retries exact settlement on finalized reconnect", () => {
  let callbackAttempts = 0;
  const settled: string[] = [];
  const realtime = finalizedRunnerRealtimeTestIntegration(
    {
      runnerConnected: () => {
        callbackAttempts += 1;
        if (callbackAttempts === 1) {
          throw new Error("callback unavailable");
        }
      },
    },
    {
      settleActivationLifecycle: (activationId, lifecycle, restartId) => {
        settled.push(`${activationId}:${lifecycle}:${String(restartId)}`);
        return true;
      },
    },
  );

  const { first, retry } = reconnectFinalizedRunnerPair(
    { machineId: "machine-callback-retry", realtime },
    {},
    () => {
      expect(settled).toEqual([]);
    },
  );
  expectRetrySequence(first, retry);
  expect(callbackAttempts).toBe(2);
  expect(settled).toEqual(["test-activation-id:ordinary:undefined"]);
});

test("contains lifecycle settlement failures and retries finalized settlement", () => {
  let callbackAttempts = 0;
  let settlementAttempts = 0;
  const realtime = finalizedRunnerRealtimeTestIntegration(
    {
      runnerConnected: () => {
        callbackAttempts += 1;
      },
    },
    {
      settleActivationLifecycle: () => {
        settlementAttempts += 1;
        if (settlementAttempts === 1) {
          throw new Error("settlement unavailable");
        }
        return true;
      },
    },
  );
  expect(callbackAttempts).toBe(0);

  const { first, retry } = reconnectFinalizedRunnerPair(
    { machineId: "machine-settlement-retry", realtime },
    {},
    (connection) => {
      expect(
        connection.data.kind === "runner"
          ? connection.data.registration
          : undefined,
      ).toBeUndefined();
      expect({ callbackAttempts, settlementAttempts }).toEqual({
        callbackAttempts: 1,
        settlementAttempts: 1,
      });
    },
  );
  expectRetrySequence(first, retry);
  expect({ callbackAttempts, settlementAttempts }).toEqual({
    callbackAttempts: 2,
    settlementAttempts: 2,
  });
});

test("a settled finalized activation reconnects without a retained receipt", () => {
  const callbacks: string[] = [];
  const connection = realtimeRunnerConnection();
  const realtime = connectedRunnerRealtimeTestIntegration(
    { runnerConnected: recordRunner(callbacks) },
    {
      preflightRegistration: () => ({
        activationId: "test-activation-id",
        finalize: () => ({ connected: connection, status: "activated" }),
        prepare: () => ({
          activationReceipt: "test-activation-receipt",
          connected: connection,
          status: "registered",
        }),
        replaysSettledFinalization: true,
        runnerId: connection.connection.id,
      }),
      receiptState: () =>
        realtimeRunnerReceiptState({ lifecycleSettled: true }),
    },
  );

  const reconnect = proposedRunnerRealtimeTestSocket(
    realtime,
    "machine-settled-finalized-reconnect",
  );
  finishPendingRunnerRegistration(realtime, reconnect);
  acknowledgeFinalizedRunnerRegistration(realtime.websocket, reconnect.socket);
  acknowledgeOperationalRunnerRegistration(
    realtime.websocket,
    reconnect.socket,
  );

  expect(reconnect.record.closed).toBeUndefined();
  expect(reconnect.record.sent).toHaveLength(5);
  expect(reconnect.socket.data).toMatchObject({ usable: true });
  expect(callbacks).toEqual(["runner-1"]);
});

test("contains false lifecycle settlement and retries finalized settlement", () => {
  let settlementAttempts = 0;
  const callbacks: string[] = [];
  const realtime = finalizedRunnerRealtimeTestIntegration(
    { runnerConnected: recordRunner(callbacks) },
    {
      settleActivationLifecycle: () => {
        settlementAttempts += 1;
        return settlementAttempts > 1;
      },
    },
  );

  const { first, retry } = reconnectFinalizedRunnerPair({
    machineId: "machine-false-settlement-retry",
    realtime,
  });
  expectRetrySequence(first, retry);
  expect(callbacks).toEqual(["runner-1", "runner-1"]);
  expect(settlementAttempts).toBe(2);
});
