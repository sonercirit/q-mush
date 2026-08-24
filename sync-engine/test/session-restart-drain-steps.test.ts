import { expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { agentSessions } from "../../shared/database/schema.ts";
import { DEVELOPMENT_RESTART_LIFECYCLE_MS } from "../../shared/development-shutdown.ts";
import { parseRestartHandoff } from "../../sync-engine/session-restart-store.ts";
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
import {
  createSessionRestartTestClock,
  type SessionRestartTestClock,
} from "./session-restart-test-clock.ts";

const AGENT_FILE_COMMAND = "read_agent_file";

function interruptedHandoff(setup: RestartStepSetup) {
  const stored = setup.database
    .select({ handoff: agentSessions.interruptedHandoff })
    .from(agentSessions)
    .get();
  return parseRestartHandoff(stored?.handoff ?? null);
}

// Always asks for one more tool call, so any step started after a drain begins
// shows up as an extra model request.
interface EndlessToolModel {
  readonly complete: AgentModel["complete"];
  steps: number;
}
function createEndlessToolModel(): EndlessToolModel {
  const model: EndlessToolModel = {
    steps: 0,
    complete: (messages) => {
      model.steps += 1;
      return Promise.resolve(
        providerStep(`Step ${String(messages.length)}.`, {
          toolCalls: [toolCall("bash", { command: "printf work", timeout: 30 })],
        }),
      );
    },
  };
  return model;
}

type InitializedSession = Readonly<{
  id: string;
  setup: RestartStepSetup;
}>;

async function initializedSessionWithOptions(
  model: AgentModel,
  options: Parameters<typeof connectedSessionSetup>[3],
): Promise<InitializedSession> {
  const setup = connectedSessionSetup(model, "api_key", undefined, options);
  const [id] = await createRestartSessions(setup, 1);
  if (id === undefined)
    throw new Error("The restart fixture created no session");
  await completeRestartCommands(setup, AGENT_FILE_COMMAND, () => "null", 1);
  return { id, setup };
}

function initializedSingleSession(
  model: AgentModel,
  commandPrefix: string,
): Promise<InitializedSession> {
  return initializedSessionWithOptions(model, {
    commandId: nextCommandId(commandPrefix),
  });
}

async function waitForBusyRunnerTool(
  initialized: InitializedSession,
): Promise<InitializedSession> {
  await waitForRestartCommands(initialized.setup, "bash", 1);
  return initialized;
}

async function startSingleBusySession(
  model: AgentModel,
  commandPrefix: string,
): Promise<InitializedSession> {
  return waitForBusyRunnerTool(
    await initializedSingleSession(model, commandPrefix),
  );
}

function startBusySession(
  model: AgentModel,
  commandPrefix: string,
): Promise<InitializedSession> {
  return initializedSingleSession(model, commandPrefix);
}

async function busyEndlessSession(commandPrefix: string): Promise<{
  readonly id: string;
  readonly model: EndlessToolModel;
  readonly setup: RestartStepSetup;
}> {
  const model = createEndlessToolModel();
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

function sessionRestartTiming(clock: SessionRestartTestClock) {
  return {
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    setTimeout: clock.setTimeout,
  };
}

async function deadlineSession(
  model: AgentModel,
  commandPrefix: string,
  clock: SessionRestartTestClock,
): Promise<DeadlineSession> {
  return waitForBusyRunnerTool(
    await initializedSessionWithOptions(model, {
      now: clock.now,
      commandId: nextCommandId(commandPrefix),
      restartTiming: sessionRestartTiming(clock),
    }),
  );
}

async function forceDrainAtDeadline(
  setup: RestartStepSetup,
  clock: SessionRestartTestClock,
  drain: () => Promise<void>,
): Promise<void> {
  const drained = drain();
  await waitForRestartDrainCount(setup.sessions, 1);
  clock.advance(DEVELOPMENT_RESTART_LIFECYCLE_MS);
  await drained;
}

test("the production session drain force-parks at its injected deadline", async () => {
  const clock = createSessionRestartTestClock();
  const { id, setup } = await deadlineSession(
    createEndlessToolModel(),
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
  const clock = createSessionRestartTestClock(1_700_000_000_000);
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
      restartTiming: sessionRestartTiming(clock),
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

test("final shutdown promotes an active runner drain to a durable server marker", async () => {
  const { setup } = await startSingleBusySession(
    createEndlessToolModel(),
    "final-promotion-command",
  );

  const runnerDrain = setup.sessions.drainRunner(
    RUNNER_ID,
    "runner-before-final",
  );
  await waitForRestartDrainCount(setup.sessions, 1);
  expect(interruptedHandoff(setup)).toBeNull();

  await setup.sessions.prepareFinalShutdown();
  expect(interruptedHandoff(setup)).toMatchObject({
    requestedBy: "server",
  });

  closeSessionTestDatabase(setup.database);
  void runnerDrain;
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
