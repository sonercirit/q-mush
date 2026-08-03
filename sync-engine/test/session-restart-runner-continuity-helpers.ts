import { expect } from "vitest";
import {
  encodeRunnerActivationReceipt,
  runnerConnectMessage,
} from "../../shared/runner-realtime-protocol.ts";
import { realtimeSocketMessage } from "./realtime-handler-fixtures.ts";
import { configuredRealtimeTestIntegration } from "./realtime-test-helpers.ts";
import {
  acceptRunnerRegistration,
  acknowledgeActiveRunnerRegistration,
  acknowledgeFinalizedRunnerRegistration,
  acknowledgeOperationalRunnerRegistration,
  realtimeTestSocket,
  receiveRunnerRegistration,
  upgradeRunnerWithToken,
} from "./realtime-test-socket-helpers.ts";
import {
  type connectedSessionSetup,
  RUNNER_ID,
  RUNNER_TOKEN,
} from "./session-integration-fixtures.ts";

const RUNNER_METADATA = {
  architecture: "x64",
  machineFingerprint: "session-test-machine",
  name: "workstation",
  platform: "linux",
} as const;

type SessionSetup = ReturnType<typeof connectedSessionSetup>;

export function durableSessionRunnerReceipt(
  setup: SessionSetup,
  restartId?: string,
): string {
  const retained = setup.runners.preflightRegistration(
    RUNNER_TOKEN,
    RUNNER_METADATA,
  );
  const prepared = retained?.prepare(restartId);
  if (prepared?.status !== "registered") {
    throw new Error("The connected runner receipt was unavailable");
  }
  return prepared.activationReceipt;
}

export function reconnectDurableSessionRunner(
  setup: SessionSetup,
  activationReceipt: string | undefined,
  restartId?: string,
) {
  const realtime = configuredRealtimeTestIntegration({
    runners: setup.runners,
    sessions: setup.sessions,
  });
  const socket = realtimeTestSocket(
    upgradeRunnerWithToken(realtime, RUNNER_TOKEN),
  );
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
        ...(activationReceipt === undefined
          ? {}
          : {
              activationReceipt: encodeRunnerActivationReceipt({
                value: activationReceipt,
              }),
            }),
        ...(restartId === undefined ? {} : { restartId }),
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
  return { realtime, socket };
}
