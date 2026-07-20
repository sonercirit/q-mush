import { expect } from "bun:test";
import { RUNNER_AGENT_FILE_COMMAND } from "../agent-file.ts";
import { isRecord } from "../auth-model.ts";
import { RUNNER_WORK_PATH, SESSIONS_PATH } from "../routes.ts";
import type { RunnerToolCommand } from "../runner-command-broker.ts";
import type { createSessionIntegration } from "../sessions.ts";
import {
  createAuthenticatedRequest,
  createRunnerRequest,
} from "./authenticated-integration-test-helpers.ts";
import {
  RUNNER_COMMAND_ID,
  RUNNER_COMMAND_PATH,
  RUNNER_TOKEN,
  SESSION_ID,
} from "./session-integration-fixtures.ts";

export async function waitForSessionValue(
  readValue: () => unknown,
  predicate: (value: unknown) => boolean,
): Promise<unknown> {
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

export async function takeRunnerCommand(
  sessions: ReturnType<typeof createSessionIntegration>,
  missingMessage: string,
): Promise<Response> {
  const response = await waitForSessionValue(
    () => sessions.work(createRunnerRequest(RUNNER_WORK_PATH, RUNNER_TOKEN)),
    (value) => value instanceof Response && value.status === 200,
  );

  if (!(response instanceof Response)) {
    throw new Error(missingMessage);
  }

  return response;
}

export async function expectRunnerCommand(
  sessions: ReturnType<typeof createSessionIntegration>,
  expected: RunnerToolCommand,
  missingMessage: string,
): Promise<void> {
  const response = await takeRunnerCommand(sessions, missingMessage);
  expect(await response.json()).toEqual({ command: expected });
}

export function completeRunnerCommand(
  sessions: ReturnType<typeof createSessionIntegration>,
  output: string,
): Promise<Response> {
  return sessions.workResult(
    createRunnerRequest(RUNNER_COMMAND_PATH, RUNNER_TOKEN, { output }),
    RUNNER_COMMAND_ID,
  );
}

export async function completeAgentFileLookup(
  sessions: ReturnType<typeof createSessionIntegration>,
  agentFile: unknown = null,
): Promise<void> {
  await expectRunnerCommand(
    sessions,
    {
      arguments: {},
      id: RUNNER_COMMAND_ID,
      sessionId: SESSION_ID,
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: "/work/project",
    },
    "The runner did not receive the agent-file command",
  );
  expect(
    (await completeRunnerCommand(sessions, JSON.stringify(agentFile))).status,
  ).toBe(204);
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
