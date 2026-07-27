import { expect, test } from "vitest";
import { RUNNERS_PATH } from "../../shared/routes.ts";
import {
  createAuthenticatedRequest,
  createAuthenticatedTestDatabase,
} from "./authenticated-integration-test-helpers.ts";
import { expectUsableRunner } from "./realtime-hardening-helpers.ts";
import {
  closeRealtimeSocket,
  proposedRunnerRealtimeTestSocket,
  realtimeTestSocket,
  receivePendingRunnerRegistration,
  runnerRealtimeWithToken,
  sendRunnerConnect,
} from "./realtime-test-socket-helpers.ts";
import {
  createTestRunnerIntegration,
  runnerMetadata,
} from "./runner-integration-test-helpers.ts";

interface DurableRealtimeSetup {
  readonly database: ReturnType<typeof createAuthenticatedTestDatabase>;
  readonly runnerId: string;
  readonly runners: ReturnType<typeof createTestRunnerIntegration>;
  readonly token: string;
}

function durableRealtimeSetup(
  name: "ordinary-retry" | "settled-reconnect",
): DurableRealtimeSetup {
  const database = createAuthenticatedTestDatabase();
  const runnerId = `runner-${name}`;
  const tokenValue = `${name}-token`;
  return {
    database,
    runnerId,
    runners: createTestRunnerIntegration(database, {
      randomId: () => runnerId,
      randomToken: () => tokenValue,
    }),
    token: `qmr_${tokenValue}`,
  };
}

function metadata(machineFingerprint: string) {
  return runnerMetadata(machineFingerprint, "runner");
}

function createRunner(runners: DurableRealtimeSetup["runners"]): void {
  const created = runners.collection(
    createAuthenticatedRequest(
      new URL(RUNNERS_PATH, "http://localhost").pathname,
      undefined,
      "POST",
    ),
  );
  expect(created.ok).toBe(true);
}

test("reconnects a settled finalized durable activation without a retained receipt", () => {
  const { database, runnerId, runners, token } =
    durableRealtimeSetup("settled-reconnect");
  createRunner(runners);
  const machine = metadata("machine-settled-reconnect");
  const activation = runners.preflightRegistration(token, machine);
  const prepared = activation?.prepare("restart-settled");
  if (activation === undefined || prepared?.status !== "registered") {
    throw new Error("The settled runner activation was not prepared");
  }
  expect(activation.finalize(prepared.activationReceipt).status).toBe(
    "activated",
  );
  expect(
    runners.settleActivationLifecycle(
      activation.activationId,
      "restart",
      "restart-settled",
    ),
  ).toBe(true);
  expect(
    runners.preflightRegistration(token, machine)?.prepare(),
  ).toMatchObject({ status: "registered" });
  const recovered: string[] = [];
  const { realtime, upgrade: upgradeWithToken } = runnerRealtimeWithToken(
    runners,
    token,
    { runnerConnected: (id) => recovered.push(id) },
  );
  const reconnect = realtimeTestSocket(upgradeWithToken());

  sendRunnerConnect(realtime.websocket, reconnect, "machine-settled-reconnect");

  expectUsableRunner(reconnect, runnerId);
  expect(recovered).toEqual([runnerId]);
  database.$client.close();
});

test("accepts an ordinary prepared receipt without a restart gate using the durable runner store", () => {
  const { database, runnerId, runners, token } =
    durableRealtimeSetup("ordinary-retry");
  createRunner(runners);
  const { realtime, upgrade: upgradeWithToken } = runnerRealtimeWithToken(
    runners,
    token,
  );
  const original = proposedRunnerRealtimeTestSocket(
    realtime,
    "machine-ordinary-retry",
    {},
    upgradeWithToken(),
  );

  receivePendingRunnerRegistration(realtime, original);
  const pending = original.socket.data;
  const receipt =
    pending.kind === "runner"
      ? pending.registration?.preparedReceipt
      : undefined;
  expect(receipt).toBeDefined();
  closeRealtimeSocket(realtime.websocket, original.socket);

  const retry = realtimeTestSocket(upgradeWithToken());
  sendRunnerConnect(
    realtime.websocket,
    retry,
    "machine-ordinary-retry",
    undefined,
    true,
    receipt,
    "prepared",
  );

  expectUsableRunner(retry, runnerId);
  database.$client.close();
});
