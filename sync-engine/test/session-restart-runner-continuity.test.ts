import { expect, test } from "vitest";
import { RUNNER_REALTIME_PATH } from "../../shared/routes.ts";
import {
  encodeRunnerActivationReceipt,
  runnerConnectMessage,
} from "../../shared/runner-realtime-protocol.ts";
import {
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { realtimeSocketMessage } from "./realtime-handler-fixtures.ts";
import {
  configuredRealtimeTestIntegration,
  RealtimeUpgradeServer,
} from "./realtime-test-helpers.ts";
import {
  acceptRunnerRegistration,
  acknowledgeActiveRunnerRegistration,
  acknowledgeFinalizedRunnerRegistration,
  acknowledgeOperationalRunnerRegistration,
  realtimeTestSocket,
  receiveRunnerRegistration,
} from "./realtime-test-socket-helpers.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
  RUNNER_TOKEN,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  completeAgentFileLookup,
  sessionDetail,
  startSessionAndCompleteAgentFile,
  waitForSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

const RUNNER_METADATA = {
  architecture: "x64",
  machineFingerprint: "session-test-machine",
  name: "workstation",
  platform: "linux",
} as const;

test("a queued continuation launches when its existing runner reconnects after server recreation", async () => {
  const model = new ScriptedAgentModel([
    { content: "Ready before restart.", toolCalls: [] },
    { content: "Continued after restart.", toolCalls: [] },
  ]);
  const initial = connectedSessionSetup(model);
  await startSessionAndCompleteAgentFile(initial);
  await waitForSessionStatus(initial, "idle");

  await initial.sessions.drain();
  const queued = await initial.sessions.realtimeCommands.messageForUser(
    TEST_AUTHENTICATED_USER,
    SESSION_ID,
    { attachments: [], images: [], prompt: "Continue after restart." },
    TEST_WORKSPACE_ID,
  );
  expect(queued.status).toBe("queued");

  const retained = initial.runners.preflightRegistration(
    RUNNER_TOKEN,
    RUNNER_METADATA,
  );
  const prepared = retained?.prepare();
  if (prepared?.status !== "registered") {
    throw new Error("The connected runner receipt was unavailable");
  }
  initial.runners.disconnected({
    id: RUNNER_ID,
    userId: TEST_USER_ID,
  });

  const recreated = connectedSessionSetup(model, "api_key", undefined, {
    database: initial.database,
  });
  expect(await sessionDetail(recreated.sessions)).toMatchObject({
    status: "queued",
  });
  const realtime = configuredRealtimeTestIntegration({
    runners: recreated.runners,
    sessions: recreated.sessions,
  });
  const request = new Request(`http://localhost${RUNNER_REALTIME_PATH}`, {
    headers: {
      authorization: `Bearer ${RUNNER_TOKEN}`,
      upgrade: "websocket",
    },
  });
  const server = new RealtimeUpgradeServer();
  const upgrade = realtime.upgrade(request, server);
  expect(upgrade).toBeUndefined();
  const socket = realtimeTestSocket(server.data);

  realtimeSocketMessage(
    realtime.websocket,
    socket,
    runnerConnectMessage(
      {
        architecture: RUNNER_METADATA.architecture,
        machineId: RUNNER_METADATA.machineFingerprint,
        name: RUNNER_METADATA.name,
        platform: RUNNER_METADATA.platform,
      },
      {
        activationReceipt: encodeRunnerActivationReceipt({
          value: prepared.activationReceipt,
        }),
      },
    ),
  );
  acceptRunnerRegistration(realtime.websocket, socket);
  receiveRunnerRegistration(realtime.websocket, socket);
  acknowledgeActiveRunnerRegistration(realtime.websocket, socket);
  acknowledgeFinalizedRunnerRegistration(realtime.websocket, socket);
  acknowledgeOperationalRunnerRegistration(realtime.websocket, socket);
  expect(socket.data).toMatchObject({
    runner: { id: RUNNER_ID },
    usable: true,
  });
  const afterReconnect = await sessionDetail(recreated.sessions);
  expect(afterReconnect).toMatchObject({ status: "queued" });

  await completeAgentFileLookup(recreated);
  await waitForSessionValue(
    () => sessionDetail(recreated.sessions),
    (detail) =>
      JSON.stringify(detail).includes("Continued after restart.") &&
      typeof detail === "object" &&
      detail !== null &&
      "status" in detail &&
      detail.status === "idle",
  );
  expect(model.requests.at(-1)).toContainEqual({
    content: "Continue after restart.",
    role: "user",
  });
  initial.database.$client.close();
});
