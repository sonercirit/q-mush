import { expect } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  createSessionRequest,
  RUNNER_COMMAND_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";

type ConnectedSessionSetup = Awaited<ReturnType<typeof connectedSessionSetup>>;

export function directoryListing() {
  return {
    directories: [{ name: "q-mush", path: "/home/mush/projects/q-mush" }],
    parent: "/home/mush",
    path: "/home/mush/projects",
    truncated: false,
  };
}

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

export function expectRunnerRequired(value: unknown): void {
  expect(value).toEqual(
    expect.objectContaining({ runnerRequired: true, status: "idle" }),
  );
}

export function expectedRunnerCommand(
  command: Partial<RunnerToolCommand> &
    Pick<RunnerToolCommand, "arguments" | "tool">,
): RunnerToolCommand {
  return {
    id: RUNNER_COMMAND_ID,
    sessionId: SESSION_ID,
    workingDirectory: "/work/project",
    ...command,
  };
}

export async function expectRunnerCommand(
  setup: ConnectedSessionSetup,
  expected: RunnerToolCommand,
  missingMessage: string,
): Promise<void> {
  const command = await waitForSessionValue(
    () => setup.runnerCommands.shift(),
    (value) => value !== undefined,
  );

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

export async function completeAgentFileLookup(
  setup: ConnectedSessionSetup,
  agentFile: unknown = null,
): Promise<void> {
  await expectRunnerCommand(
    setup,
    {
      arguments: {},
      id: RUNNER_COMMAND_ID,
      sessionId: SESSION_ID,
      tool: RUNNER_AGENT_FILE_COMMAND,
      workingDirectory: "/work/project",
    },
    "The runner did not receive the agent-file command",
  );
  expect(completeRunnerCommand(setup, JSON.stringify(agentFile)).status).toBe(
    204,
  );
}

export async function expectTranscriptExcludes(
  setup: ReturnType<typeof connectedSessionSetup>,
  content: string,
): Promise<void> {
  expect(JSON.stringify(await sessionDetail(setup.sessions))).not.toContain(
    content,
  );
}

export async function startSession(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<Response> {
  return setup.sessions.collection(createSessionRequest());
}

export async function startSessionAndCompleteAgentFile(
  setup: ReturnType<typeof connectedSessionSetup>,
): Promise<Response> {
  const created = await startSession(setup);
  expect(created.status).toBe(201);
  await completeAgentFileLookup(setup);
  return created;
}

export async function startSessionAndExpectRunnerCommand(
  setup: ReturnType<typeof connectedSessionSetup>,
  command: ReturnType<typeof expectedRunnerCommand>,
  missingMessage: string,
): Promise<void> {
  await startSessionAndCompleteAgentFile(setup);
  await expectRunnerCommand(setup, command, missingMessage);
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
