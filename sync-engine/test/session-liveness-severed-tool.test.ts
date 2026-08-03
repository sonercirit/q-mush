import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import {
  TEST_NOW,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { realtimeSocketMessage } from "./realtime-handler-fixtures.ts";
import {
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import {
  durableSessionRunnerReceipt,
  reconnectDurableSessionRunner,
} from "./session-restart-runner-continuity-helpers.ts";
import {
  MultiSessionRestartModel,
  nextCommandId,
} from "./session-restart-step-resume-helpers.ts";

const GRACE_MS = 60_000;
const BLIP_MS = 5_000;

function readCommandId(messages: readonly string[], tool: string): string {
  for (const message of messages) {
    const value: unknown = JSON.parse(message);
    if (
      isRecord(value) &&
      value["type"] === "command" &&
      isRecord(value["command"]) &&
      value["command"]["tool"] === tool &&
      typeof value["command"]["id"] === "string"
    ) {
      return value["command"]["id"];
    }
  }
  throw new Error(`The reconnected runner did not receive ${tool}`);
}

function recoveryModel() {
  return scriptedModel([
    {
      content: "Reading before the connection is severed.",
      toolCalls: [toolCall("read", { path: "README.md" })],
    },
    { content: "Recovered after the runner reconnected.", toolCalls: [] },
  ]);
}

function sequenceCommandIds(): () => string {
  let sequence = 0;
  return () => `agent-command-${String(++sequence)}`;
}

async function severedToolSetup() {
  let now = TEST_NOW;
  let scan: (() => void) | undefined;
  const setup = await startToolSession(recoveryModel(), {
    commandId: sequenceCommandIds(),
    liveness: {
      graceMs: GRACE_MS,
      intervalMs: 10_000,
      setInterval: (callback) => {
        scan = callback;
        return 1;
      },
    },
    now: () => now,
  });
  const command = await waitForSessionValue(
    setup.latestRunnerCommand,
    (candidate) => isRecord(candidate) && candidate["tool"] === "read",
  );
  expect(command).toMatchObject({ id: "agent-command-2", tool: "read" });
  if (scan === undefined) {
    throw new Error("The liveness scan was not scheduled");
  }
  const activationReceipt = durableSessionRunnerReceipt(setup);
  setup.sessions.runnerDisconnected(RUNNER_ID);
  setup.runners.disconnected({ id: RUNNER_ID, userId: TEST_USER_ID });
  scan();
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    activationReceipt,
    scan,
    setup,
  };
}

test("a five-second runner blip redelivers the severed tool and completes automatically", async () => {
  const recovery = await severedToolSetup();
  recovery.advance(BLIP_MS);

  const reconnected = reconnectDurableSessionRunner(
    recovery.setup,
    recovery.activationReceipt,
  );
  const commandId = readCommandId(reconnected.socket.sent, "read");
  realtimeSocketMessage(
    reconnected.realtime.websocket,
    reconnected.socket,
    JSON.stringify({
      commandId,
      output: "# Q Mush",
      state: "completed",
      type: "result",
    }),
  );

  const completed = await waitForSessionValue(
    () => recovery.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    (detail) =>
      hasSessionStatus("idle")(detail) &&
      JSON.stringify(detail).includes(
        "Recovered after the runner reconnected.",
      ),
  );
  expect(completed).toMatchObject({ status: "idle" });
  recovery.advance(GRACE_MS);
  recovery.scan();
  expect(
    recovery.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status,
  ).toBe("idle");
  recovery.setup.database.$client.close();
});

test("a planned-restart reconnect becomes healthy on the production operational path", async () => {
  let now = TEST_NOW;
  let scan: (() => void) | undefined;
  const setup = connectedSessionSetup(
    new MultiSessionRestartModel(),
    "api_key",
    undefined,
    {
      commandId: nextCommandId("planned-restart"),
      liveness: {
        graceMs: GRACE_MS,
        intervalMs: 10_000,
        setInterval: () => 1,
        testScan: (scheduled) => {
          scan = scheduled;
        },
      },
      now: () => now,
    },
  );
  expect((await setup.sessions.collection(createSessionRequest())).status).toBe(
    201,
  );
  const agentFile = await waitForSessionValue(
    setup.latestRunnerCommand,
    (candidate) =>
      isRecord(candidate) && candidate["tool"] === "read_agent_file",
  );
  if (!isRecord(agentFile) || typeof agentFile["id"] !== "string") {
    throw new Error("The agent-file command was unavailable");
  }
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, agentFile["id"], {
      output: "null",
      state: "completed",
    }),
  ).toBe(true);
  const command = await waitForSessionValue(
    setup.latestRunnerCommand,
    (candidate) => isRecord(candidate) && candidate["tool"] === "bash",
  );
  if (!isRecord(command) || typeof command["id"] !== "string") {
    throw new Error("The planned-restart command was unavailable");
  }
  const restartId = "planned-restart-liveness";
  const drain = setup.sessions.drainRunner(RUNNER_ID, restartId);
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, command["id"], {
      output: "Durable tool output after planned restart.",
      state: "completed",
    }),
  ).toBe(true);
  await drain;
  expect(setup.sessions.pendingRunnerRestart(RUNNER_ID)).toMatchObject({
    requestedBy: "runner",
    restartId,
    status: "pending",
  });
  setup.sessions.runnerDisconnected(RUNNER_ID);
  setup.runners.disconnected({ id: RUNNER_ID, userId: TEST_USER_ID });

  reconnectDurableSessionRunner(setup, undefined, restartId);
  now += 1;
  setup.runners.seen({ id: RUNNER_ID, userId: TEST_USER_ID });
  const resumedAgentFile = await waitForSessionValue(
    setup.latestRunnerCommand,
    (candidate) =>
      isRecord(candidate) &&
      candidate["tool"] === "read_agent_file" &&
      candidate["id"] !== agentFile["id"],
  );
  if (
    !isRecord(resumedAgentFile) ||
    typeof resumedAgentFile["id"] !== "string"
  ) {
    throw new Error("The resumed agent-file command was unavailable");
  }
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, resumedAgentFile["id"], {
      output: "null",
      state: "completed",
    }),
  ).toBe(true);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    hasSessionStatus("idle"),
  );
  expect(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)).toMatchObject({
    restartHandoff: null,
    status: "idle",
  });
  if (scan === undefined) throw new Error("The liveness scan was not captured");
  now += GRACE_MS;
  scan();
  expect(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status).toBe(
    "idle",
  );
  setup.database.$client.close();
});

test("a severed tool fails only after the runner misses the reconnect grace", async () => {
  const recovery = await severedToolSetup();

  expect(
    recovery.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status,
  ).toBe("running");
  recovery.advance(GRACE_MS - 1);
  recovery.scan();
  expect(
    recovery.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status,
  ).toBe("running");

  recovery.advance(1);
  recovery.scan();
  const failed = await waitForSessionValue(
    () => recovery.setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
    hasSessionStatus("failed"),
  );
  expect(JSON.stringify(failed)).toContain(
    "runner command that could not be dispatched during the recovery window",
  );
  recovery.setup.database.$client.close();
});
