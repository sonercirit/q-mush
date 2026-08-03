import { expect, test } from "vitest";
import { isRecord } from "../../shared/auth-model.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
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
  closeLivenessSession,
  sessionDetailStatus,
  testLivenessClock,
} from "./session-liveness-test-helpers.ts";
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

function requireRunnerCommandFrame(
  message: string,
): Readonly<Record<string, unknown>> | undefined {
  const value: unknown = JSON.parse(message);
  if (!isRecord(value) || value["type"] !== "command") {
    return undefined;
  }
  const command = value["command"];
  return isRecord(command) ? command : undefined;
}

function readCommandId(messages: readonly string[], tool: string): string {
  for (const message of messages) {
    const command = requireRunnerCommandFrame(message);
    if (command?.["tool"] === tool && typeof command["id"] === "string") {
      return command["id"];
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

async function runnerCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  tool: string,
  previousId?: unknown,
) {
  return waitForSessionValue(
    setup.latestRunnerCommand,
    (candidate) =>
      isRecord(candidate) &&
      candidate["tool"] === tool &&
      candidate["id"] !== previousId,
  );
}

function requireCommandId(command: unknown, description: string): string {
  if (!isRecord(command) || typeof command["id"] !== "string") {
    throw new Error(`The ${description} command was unavailable`);
  }
  return command["id"];
}

function completeCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  command: unknown,
  output: string,
  description: string,
): void {
  expect(
    setup.sessions.completeRunnerCommand(
      RUNNER_ID,
      requireCommandId(command, description),
      { output, state: "completed" },
    ),
  ).toBe(true);
}

function readSessionDetail(
  setup: Pick<ReturnType<typeof connectedSessionSetup>, "sessions">,
) {
  return setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
}

async function waitForStatus(
  setup: Pick<ReturnType<typeof connectedSessionSetup>, "sessions">,
  status: string,
) {
  return waitForSessionValue(
    () => readSessionDetail(setup),
    hasSessionStatus(status),
  );
}

function expectDetailStatus(
  setup: Pick<ReturnType<typeof connectedSessionSetup>, "sessions">,
  status: string,
): void {
  expect(sessionDetailStatus(setup, SESSION_ID)).toBe(status);
}

async function severedToolSetup() {
  const clock = testLivenessClock(GRACE_MS, 10_000);
  const setup = await startToolSession(recoveryModel(), {
    commandId: sequenceCommandIds(),
    liveness: clock.dependencies,
    now: clock.now,
  });
  const command = await runnerCommand(setup, "read");
  expect(command).toMatchObject({ id: "agent-command-2", tool: "read" });
  const activationReceipt = durableSessionRunnerReceipt(setup);
  clock.connectionLost(setup);
  clock.scan();
  return { activationReceipt, clock, setup };
}

test("a five-second runner blip redelivers the severed tool and completes automatically", async () => {
  const recovery = await severedToolSetup();
  recovery.clock.advance(BLIP_MS);

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
    () => readSessionDetail(recovery.setup),
    (detail) =>
      hasSessionStatus("idle")(detail) &&
      JSON.stringify(detail).includes(
        "Recovered after the runner reconnected.",
      ),
  );
  expect(completed).toMatchObject({ status: "idle" });
  recovery.clock.advance(GRACE_MS);
  recovery.clock.scan();
  expectDetailStatus(recovery.setup, "idle");
  closeLivenessSession(recovery.setup);
});

test("a planned-restart reconnect becomes healthy on the production operational path", async () => {
  const clock = testLivenessClock(GRACE_MS, 10_000);
  const setup = connectedSessionSetup(
    new MultiSessionRestartModel(),
    "api_key",
    undefined,
    {
      commandId: nextCommandId("planned-restart"),
      liveness: clock.dependencies,
      now: clock.now,
    },
  );
  expect((await setup.sessions.collection(createSessionRequest())).status).toBe(
    201,
  );
  const agentFile = await runnerCommand(setup, "read_agent_file");
  completeCommand(setup, agentFile, "null", "agent-file");
  const command = await runnerCommand(setup, "bash");
  const restartId = "planned-restart-liveness";
  const drain = setup.sessions.drainRunner(RUNNER_ID, restartId);
  completeCommand(
    setup,
    command,
    "Durable tool output after planned restart.",
    "planned-restart",
  );
  await drain;
  expect(setup.sessions.pendingRunnerRestart(RUNNER_ID)).toMatchObject({
    requestedBy: "runner",
    restartId,
    status: "pending",
  });
  clock.connectionLost(setup);

  reconnectDurableSessionRunner(setup, undefined, restartId);
  clock.advance(1);
  setup.runners.seen({ id: RUNNER_ID, userId: TEST_USER_ID });
  const resumedAgentFile = await runnerCommand(
    setup,
    "read_agent_file",
    requireCommandId(agentFile, "agent-file"),
  );
  completeCommand(setup, resumedAgentFile, "null", "resumed agent-file");
  await waitForStatus(setup, "idle");
  expect(readSessionDetail(setup)).toMatchObject({
    restartHandoff: null,
    status: "idle",
  });
  clock.advance(GRACE_MS);
  clock.scan();
  expectDetailStatus(setup, "idle");
  closeLivenessSession(setup);
});

test("a severed tool fails only after the runner misses the reconnect grace", async () => {
  const recovery = await severedToolSetup();

  expectDetailStatus(recovery.setup, "running");
  recovery.clock.advance(GRACE_MS - 1);
  recovery.clock.scan();
  expectDetailStatus(recovery.setup, "running");

  recovery.clock.advance(1);
  recovery.clock.scan();
  const failed = await waitForStatus(recovery.setup, "failed");
  expect(JSON.stringify(failed)).toContain(
    "runner command that could not be dispatched during the recovery window",
  );
  closeLivenessSession(recovery.setup);
});
