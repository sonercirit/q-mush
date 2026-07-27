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
import { createTestRunnerIntegration } from "./runner-integration-test-helpers.ts";

test("accepts an ordinary prepared receipt without a restart gate using the durable runner store", () => {
  const database = createAuthenticatedTestDatabase();
  const runnerId = "runner-ordinary-retry";
  const tokenValue = "ordinary-retry-token";
  const token = `qmr_${tokenValue}`;

  const runners = createTestRunnerIntegration(database, {
    randomId: () => runnerId,
    randomToken: () => tokenValue,
  });
  const setupResponse = runners.collection(
    createAuthenticatedRequest(RUNNERS_PATH, undefined, "POST"),
  );
  expect(setupResponse.status).toBe(201);
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
