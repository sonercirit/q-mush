import { expect } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import { runnerCleanupCommand } from "../../shared/test/runner-command-fixtures.ts";
import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  RUNNER_COMMAND_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";

type ConnectedSessionSetup = Awaited<ReturnType<typeof connectedSessionSetup>>;

export async function waitForSessionValue<Value>(
  readValue: () => Promise<Value> | Value,
  predicate: (value: Value) => boolean,
): Promise<Value> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await Promise.resolve(readValue());

    if (predicate(value)) {
      return value;
    }

    await Bun.sleep(1);
  }

  throw new Error("The session test timed out");
}

export function hasSessionStatus(
  expected: string,
): (value: unknown) => boolean {
  return (value) => isRecord(value) && value["status"] === expected;
}

export async function waitForSessionDetail(
  setup: ConnectedSessionSetup,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
  return waitForSessionValue(() => sessionDetail(setup.sessions), predicate);
}

export async function waitForSessionStatus(
  setup: ConnectedSessionSetup,
  status: string,
): Promise<unknown> {
  return waitForSessionDetail(setup, hasSessionStatus(status));
}

export function waitForRunnerCommand(
  setup: ConnectedSessionSetup,
): Promise<RunnerToolCommand | undefined> {
  return waitForSessionValue(
    () => setup.runnerCommands.shift(),
    (value) => value !== undefined,
  );
}

export async function expectRunnerCommand(
  setup: ConnectedSessionSetup,
  expected: RunnerToolCommand,
  missingMessage: string,
): Promise<void> {
  const command = await waitForRunnerCommand(setup);

  if (command === undefined) {
    throw new Error(missingMessage);
  }

  expect(command).toEqual(expected);
}

export function completeRunnerCommand(
  setup: ConnectedSessionSetup,
  output: string,
): Response {
  return new Response(null, {
    status: setup.sessions.completeRunnerCommand(
      "018bcfe5-6800-7000-8000-000000000061",
      setup.latestRunnerCommand()?.id ?? "missing-command",
      output,
    )
      ? 204
      : 404,
  });
}

export async function expectSessionRunnerCommand(
  setup: ConnectedSessionSetup,
  command: Omit<RunnerToolCommand, "id" | "sessionId" | "workingDirectory">,
  missingMessage: string,
): Promise<void> {
  await expectRunnerCommand(
    setup,
    {
      ...command,
      id: RUNNER_COMMAND_ID,
      sessionId: SESSION_ID,
      workingDirectory: "/work/project",
    },
    missingMessage,
  );
}

export async function completeAgentFileLookup(
  setup: ConnectedSessionSetup,
  agentFile: unknown = null,
  executionEnvironment: RunnerToolCommand["executionEnvironment"] = "bare_metal",
): Promise<void> {
  await expectSessionRunnerCommand(
    setup,
    {
      ...runnerCleanupCommand(executionEnvironment),
      tool: RUNNER_AGENT_FILE_COMMAND,
    },
    "The runner did not receive the agent-file command",
  );
  expect(completeRunnerCommand(setup, JSON.stringify(agentFile)).status).toBe(
    204,
  );
}

export async function sessionDetail(
  sessions: ReturnType<typeof createSessionIntegration>,
): Promise<unknown> {
  const response = sessions.item(
    createAuthenticatedRequest(`${SESSIONS_PATH}/${SESSION_ID}`),
    SESSION_ID,
  );
  return response.json();
}
