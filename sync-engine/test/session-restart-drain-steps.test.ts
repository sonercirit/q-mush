import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { RESTART_DRAIN_LIMIT_MS } from "../../shared/development-shutdown.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import { waitForRestartDrainCount } from "./session-restart-progress-test-helpers.ts";
import {
  completeRestartCommand,
  completeRestartCommands,
  createRestartSessions,
  expectRestartPaused,
  MultiSessionRestartModel,
  nextCommandId,
  recreateRestartSetup,
  restartSessionDetail,
  waitForRestartCommands,
  type RestartStepSetup,
} from "./session-restart-step-resume-helpers.ts";
import { SessionRestartTestClock } from "./session-restart-test-clock.ts";

const AGENT_FILE_COMMAND = "read_agent_file";

// Always asks for one more tool call, so any step started after a drain begins
// shows up as an extra model request.
class EndlessToolModel implements AgentModel {
  steps = 0;

  complete(
    messages: readonly AgentConversationMessage[],
  ): Promise<AgentModelStep> {
    this.steps += 1;
    return Promise.resolve(
      providerStep(`Step ${String(messages.length)}.`, {
        toolCalls: [toolCall("bash", { command: "printf work", timeout: 30 })],
      }),
    );
  }
}

async function startBusySession(
  model: AgentModel,
  commandPrefix: string,
): Promise<{ readonly id: string; readonly setup: RestartStepSetup }> {
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId(commandPrefix),
  });
  const id = (await createRestartSessions(setup, 1))[0];
  if (id === undefined) {
    throw new Error("The drain step fixture created no session");
  }
  await completeRestartCommands(setup, AGENT_FILE_COMMAND, () => "null", 1);
  return { id, setup };
}

async function busyEndlessSession(commandPrefix: string): Promise<{
  readonly id: string;
  readonly model: EndlessToolModel;
  readonly setup: RestartStepSetup;
}> {
  const model = new EndlessToolModel();
  return { model, ...(await startBusySession(model, commandPrefix)) };
}

async function drainAfterToolCompletes(
  setup: RestartStepSetup,
  output: string,
  model: EndlessToolModel,
): Promise<number> {
  const commands = await waitForRestartCommands(setup, "bash", 1);
  // Snapshotted once the session is inside its tool call, so any further step
  // would be one the drain failed to prevent.
  const stepsBeforeDrain = model.steps;
  const drained = setup.sessions.drain();
  // The awaited tool returns normally, so the loop reaches its step boundary
  // with the restart already pending.
  const command = commands[0];
  if (command === undefined) {
    throw new Error("The busy restart tool command is unavailable");
  }
  expect(completeRestartCommand(setup, command, output)).toBe(true);
  await drained;
  return stepsBeforeDrain;
}

async function expectNoPostDrainStep(
  model: EndlessToolModel,
  setup: RestartStepSetup,
  output: string,
): Promise<void> {
  const stepsBeforeDrain = await drainAfterToolCompletes(setup, output, model);
  expect(model.steps).toBe(stepsBeforeDrain);
}

function sessionHasStatus(status: string): (value: unknown) => boolean {
  return (value) =>
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === status;
}

interface DeadlineSession {
  readonly id: string;
  readonly setup: RestartStepSetup;
}

async function deadlineSession(
  model: AgentModel,
  commandPrefix: string,
  clock: SessionRestartTestClock,
): Promise<DeadlineSession> {
  const setup = connectedSessionSetup(model, "api_key", undefined, {
    now: clock.now,
    commandId: nextCommandId(commandPrefix),
    restartTiming: {
      clearTimeout: clock.clearTimeout,
      setTimeout: clock.setTimeout,
    },
  });
  const ids = await createRestartSessions(setup, 1);
  const id = ids.at(0);
  if (id === undefined) throw new Error("The deadline fixture has no session");
  await completeRestartCommands(setup, AGENT_FILE_COMMAND, () => "null", 1);
  await waitForRestartCommands(setup, "bash", 1);
  return { id, setup };
}

async function forceDrainAtDeadline(
  setup: RestartStepSetup,
  clock: SessionRestartTestClock,
  drain: () => Promise<void>,
): Promise<void> {
  const drained = drain();
  await waitForRestartDrainCount(setup.sessions, 1);
  clock.advance(RESTART_DRAIN_LIMIT_MS);
  await drained;
}

test("the production session drain force-parks at its injected deadline", async () => {
  const clock = new SessionRestartTestClock();
  const { id, setup } = await deadlineSession(
    new EndlessToolModel(),
    "deadline-command",
    clock,
  );
  await forceDrainAtDeadline(setup, clock, () => setup.sessions.drain());

  expect(setup.sessions.drainProgress()).toEqual([]);
  await setup.sessions.drainFinal();
  expect(restartSessionDetail(setup, id)).toMatchObject({ status: "paused" });
  closeSessionTestDatabase(setup.database);
});

test("a forced runner drain persists and resumes its runner handoff", async () => {
  const clock = new SessionRestartTestClock(1_700_000_000_000);
  const { id, setup } = await deadlineSession(
    new MultiSessionRestartModel(),
    "runner-deadline-command",
    clock,
  );

  const restartId = "runner-deadline";
  await forceDrainAtDeadline(setup, clock, () =>
    setup.sessions.drainRunner(RUNNER_ID, restartId),
  );
  const parked = await waitForSessionValue(
    () => restartSessionDetail(setup, id),
    sessionHasStatus("paused"),
  );
  expect(parked).toMatchObject({ status: "paused" });

  expect(restartSessionDetail(setup, id)).toMatchObject({
    restartHandoff: { requestedBy: "runner", restartId },
    status: "paused",
  });
  const recreated = connectedSessionSetup(
    new MultiSessionRestartModel(),
    "api_key",
    undefined,
    {
      commandId: nextCommandId("runner-resumed-command"),
      database: setup.database,
      now: clock.now,
      restartTiming: {
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
      },
    },
  );
  recreated.runners.seen({ id: RUNNER_ID, userId: TEST_USER_ID });
  recreated.sessions.runnerRestartReady(RUNNER_ID, restartId);
  recreated.sessions.runnerOperational(RUNNER_ID, restartId);
  const resumedAgentFile = await waitForRestartCommands(
    recreated,
    AGENT_FILE_COMMAND,
    1,
  );
  const agentFileCommand = resumedAgentFile[0];
  if (agentFileCommand === undefined) {
    throw new Error("The resumed agent-file command is unavailable");
  }
  expect(completeRestartCommand(recreated, agentFileCommand, "null")).toBe(
    true,
  );
  await completeRestartCommands(
    recreated,
    "bash",
    () => "Durable tool output after runner restart.",
    1,
  );
  await waitForSessionValue(
    () => restartSessionDetail(recreated, id)?.status,
    (status) => status === "idle",
  );
  closeSessionTestDatabase(setup.database);
});

test("no new model step starts once a drain begins", async () => {
  const { id, model, setup } = await busyEndlessSession("drain-step-command");

  await expectNoPostDrainStep(model, setup, "Tool finished during the drain.");

  expectRestartPaused(setup, id);
  closeSessionTestDatabase(setup.database);
});

test("a session resumed from a handoff still parks at the next drain", async () => {
  const { id, model, setup } = await busyEndlessSession("drain-resume-command");
  await drainAfterToolCompletes(setup, "First tool finished.", model);

  const recreated = recreateRestartSetup(model, setup, "drain-resumed-command");
  recreated.sessions.runnerConnected(RUNNER_ID);
  await completeRestartCommands(recreated, AGENT_FILE_COMMAND, () => "null", 1);
  await expectNoPostDrainStep(model, recreated, "Resumed tool finished.");
  await waitForSessionValue(
    () => restartSessionDetail(recreated, id)?.status,
    (value) => value === "paused",
  );
  closeSessionTestDatabase(setup.database);
});
