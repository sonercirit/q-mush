import { expect } from "vitest";
import { RUNNER_AGENT_FILE_COMMAND } from "../../shared/agent-file.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { RunnerToolCommand } from "../../shared/runner-command-broker.ts";
import type { createSessionIntegration } from "../../sync-engine/sessions.ts";
import { createAuthenticatedRequest } from "./authenticated-integration-test-helpers.ts";
import {
  deferredSessionSetup,
  type DeferredAgentModel,
} from "./deferred-agent-model.ts";
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

export async function waitForSessionStatus(
  setup: ReturnType<typeof connectedSessionSetup>,
  status: string,
): Promise<void> {
  await waitForSessionValue(
    () => sessionDetail(setup.sessions),
    hasSessionStatus(status),
  );
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
    executionEnvironment: "bare_metal",
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
      { output, state: output.startsWith("Error: ") ? "failed" : "completed" },
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
      executionEnvironment: "bare_metal",
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

export async function expectSessionReaches(
  setup: ConnectedSessionSetup,
  response: Response,
  status: string,
): Promise<unknown> {
  expect(response.status).toBe(201);
  await completeAgentFileLookup(setup);
  await waitForSessionStatus(setup, status);
  return sessionDetail(setup.sessions);
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
  agentFile: unknown = null,
): Promise<Response> {
  const created = await startSession(setup);
  expect(created.status).toBe(201);
  await completeAgentFileLookup(setup, agentFile);
  return created;
}

export function expectSingleTranscriptOccurrence(
  detail: unknown,
  content: string,
): void {
  expect(JSON.stringify(detail).split(content)).toHaveLength(2);
}

export function expectSingleModelRequest(
  model: Readonly<{ readonly requests: readonly unknown[] }>,
): void {
  expect(model.requests).toHaveLength(1);
}

async function expectIdleSessionWithoutRestart(
  sessions: ReturnType<typeof connectedSessionSetup>["sessions"],
): Promise<void> {
  expect(await sessionDetail(sessions)).toMatchObject({
    restartHandoff: null,
    status: "idle",
  });
}

export async function reconnectRunnerAndExpectNoReplay(
  setup: ReturnType<typeof connectedSessionSetup>,
  model: Readonly<{ readonly requests: readonly unknown[] }>,
  runnerId: string,
  repetitions = 1,
): Promise<void> {
  for (let reconnect = 0; reconnect < repetitions; reconnect += 1) {
    setup.sessions.runnerConnected(runnerId);
  }
  await Bun.sleep(1);
  expectSingleModelRequest(model);
  await expectIdleSessionWithoutRestart(setup.sessions);
}

export async function createStartedDeferredSession(): Promise<
  Readonly<{
    created: Response;
    model: DeferredAgentModel;
    setup: ReturnType<typeof connectedSessionSetup>;
  }>
> {
  const { model, setup } = deferredSessionSetup();
  const created = await startDeferredSession(
    setup,
    () => model.requests.length,
  );
  return { created, model, setup };
}

async function drainedDeferredTerminalSession(
  content = "One durable answer.",
): Promise<Awaited<ReturnType<typeof createStartedDeferredSession>>> {
  const result = await createStartedDeferredSession();
  expect(result.created.status).toBe(201);
  const drain = result.setup.sessions.drain();
  result.model.resolveContent(content);
  await drain;
  return result;
}

export interface DrainedTerminalAssertionInput {
  readonly model: DeferredAgentModel;
  readonly setup: ReturnType<typeof connectedSessionSetup>;
  readonly terminal: unknown;
}

export async function expectDrainedTerminalSession(
  assertTerminal: (
    result: DrainedTerminalAssertionInput,
  ) => Promise<void> | void,
): Promise<void> {
  const { model, setup } = await drainedDeferredTerminalSession();
  const terminal = await sessionDetail(setup.sessions);
  await assertTerminal({ model, setup, terminal });
  setup.database.$client.close();
}

async function startDeferredSession(
  setup: ReturnType<typeof connectedSessionSetup>,
  requestCount: () => number,
): Promise<Response> {
  const created = await startSessionAndCompleteAgentFile(setup);
  await waitForSessionValue(requestCount, (requests) => requests === 1);
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
