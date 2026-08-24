import { expect } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { TEST_USER_ID } from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { toolCall } from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  createSessionRequest,
  RUNNER_ID,
} from "./session-integration-fixtures.ts";
import { waitForSessionValue } from "./session-integration-helpers.ts";
import { completeTestRunnerCommands } from "./session-runner-command-helpers.ts";

export const RESTART_SESSION_COUNT = 3;

export type RestartStepSetup = ReturnType<typeof connectedSessionSetup>;

export function createMultiSessionRestartModel(): AgentModel {
  return {
    complete(messages) {
      const completed = messages.some((message) =>
        message.content.includes("Durable tool output"),
      );
      return Promise.resolve(
        completed
          ? providerStep("Completed after restart.")
          : providerStep("Using a tool.", {
              toolCalls: [
                toolCall("bash", { command: "printf durable", timeout: 30 }),
              ],
            }),
      );
    },
  };
}

export function restartSessionIds(setup: RestartStepSetup): readonly string[] {
  return setup.sessions.listForUser(TEST_USER_ID).map(({ id }) => id);
}

export function nextCommandId(prefix: string): () => string {
  let commandId = 0;
  return () => `${prefix}-${String((commandId += 1))}`;
}

export async function waitForRestartCommands(
  setup: RestartStepSetup,
  tool: string,
  count = RESTART_SESSION_COUNT,
) {
  await waitForSessionValue(
    () =>
      setup.runnerCommands.filter((command) => command.tool === tool).length,
    (value) => value === count,
  );
  const commands = setup.runnerCommands.filter(
    (command) => command.tool === tool,
  );
  setup.runnerCommands.splice(0);
  return commands;
}

export function recreateRestartSetup(
  model: AgentModel,
  initial: RestartStepSetup,
  commandPrefix: string,
): RestartStepSetup {
  return connectedSessionSetup(model, "api_key", undefined, {
    commandId: nextCommandId(commandPrefix),
    database: initial.database,
  });
}

export function restartSessionDetail(
  setup: RestartStepSetup,
  sessionId: string,
): AgentSessionDetail | undefined {
  return setup.sessions.detailForUser(TEST_USER_ID, sessionId);
}

export function restartSessionsInclude(
  setup: RestartStepSetup,
  ids: readonly string[],
  content: string,
): boolean {
  return ids.every((id) =>
    JSON.stringify(restartSessionDetail(setup, id)).includes(content),
  );
}

export function expectRestartPaused(
  setup: RestartStepSetup,
  sessionId: string,
): void {
  expect(restartSessionDetail(setup, sessionId)).toMatchObject({
    restartHandoff: { operation: "agent" },
    status: "paused",
  });
}

export function restartSessionStatuses(
  setup: RestartStepSetup,
  ids: readonly string[],
): ReadonlySet<string | undefined> {
  return new Set(ids.map((id) => restartSessionDetail(setup, id)?.status));
}

export function completeRestartCommand(
  setup: RestartStepSetup,
  command: Readonly<{ readonly id: string }>,
  output: string,
): boolean {
  return setup.sessions.completeRunnerCommand(RUNNER_ID, command.id, {
    output,
    state: "completed",
  });
}

export async function completeRestartCommands(
  setup: RestartStepSetup,
  tool: string,
  output: (sessionId: string) => string,
  count = RESTART_SESSION_COUNT,
): Promise<void> {
  const commands = await waitForRestartCommands(setup, tool, count);
  completeTestRunnerCommands(setup, commands, (command) => ({
    output: output(command.sessionId),
    state: "completed",
  }));
}

export async function createRestartSessions(
  setup: RestartStepSetup,
  count: number,
): Promise<readonly string[]> {
  for (let index = 0; index < count; index += 1) {
    const created = await setup.sessions.collection(createSessionRequest());
    expect(created.status).toBe(201);
  }
  return restartSessionIds(setup);
}
