import { expect } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  SESSION_OPENROUTER_PROVIDERS_PATH,
  SESSIONS_PATH,
} from "../../shared/routes.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  RUNNER_COMMAND_ID,
  SESSION_ID,
  type connectedSessionSetup,
} from "./session-integration-fixtures.ts";

type ConnectedSessionSetup = Awaited<ReturnType<typeof connectedSessionSetup>>;

export async function discoverProvidersForCredential(
  setup: ConnectedSessionSetup,
  credentialId: string,
): Promise<Response> {
  return setup.sessions.openRouterProviders(
    createAuthenticatedRequest(
      `${SESSION_OPENROUTER_PROVIDERS_PATH}?credentialId=${credentialId}&model=vendor%2Fmodel`,
    ),
  );
}

export async function expectJsonResponse(
  response: Response,
  status: number,
  expected: unknown,
): Promise<void> {
  const body: unknown = await response.json();
  expect(body).toEqual(expected);
  expect(response.status).toBe(status);
}

export async function expectSessionReaches(
  setup: ConnectedSessionSetup,
  response: Response,
  status: string,
): Promise<unknown> {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
  return sessionDetail(setup.sessions);
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

export async function sendSessionMessage(
  setup: ConnectedSessionSetup,
  prompt: string,
): Promise<Response> {
  return setup.sessions.message(
    createAuthenticatedRequest(
      `${SESSIONS_PATH}/${SESSION_ID}/messages`,
      { prompt },
      "POST",
    ),
    SESSION_ID,
  );
}

function sessionHasContent(content: string): (value: unknown) => boolean {
  return (value) =>
    hasSessionStatus("idle")(value) && JSON.stringify(value).includes(content);
}

export async function waitForIdleContent(
  setup: ConnectedSessionSetup,
  content: string,
): Promise<unknown> {
  await completeAgentFileLookup(setup);
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    sessionHasContent(content),
  );
}

export async function postSessionAction(
  setup: ConnectedSessionSetup,
  action: "compact" | "continue",
  expectedContent: string,
): Promise<unknown> {
  const request = createAuthenticatedRequest(
    `${SESSIONS_PATH}/${SESSION_ID}/${action}`,
    undefined,
    "POST",
  );
  const response = await setup.sessions[action](request, SESSION_ID);
  expect(response.status).toBe(202);
  return waitForIdleContent(setup, expectedContent);
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
