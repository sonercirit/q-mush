import { expect, test } from "vitest";
import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../../shared/agent-loop.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";
import {
  completeRestartCommand,
  completeRestartCommands,
  createRestartSessions,
  expectRestartPaused,
  nextCommandId,
  recreateRestartSetup,
  restartSessionDetail,
  waitForRestartCommands,
  type RestartStepSetup,
} from "./session-restart-step-resume-helpers.ts";

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
