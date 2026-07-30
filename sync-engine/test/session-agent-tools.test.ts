import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createAuthenticatedRequest,
  TEST_AUTHENTICATED_USER,
  TEST_USER_ID,
  TEST_WORKSPACE_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerTurn } from "./provider-turn-fixtures.ts";
import {
  jsonRecord,
  records,
  testRecord,
} from "./session-agent-output-helpers.ts";
import {
  closeToolSession,
  findToolResultContent,
} from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  completedParentToolOutputs,
  scriptedModel,
  startToolSession,
  toolCall,
  waitForSessionContent,
} from "./session-agent-tool-setup.ts";
import { completeNullRunnerCommand } from "./session-compaction-test-helpers.ts";
import {
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  expectRunnerRequired,
  expectTranscriptExcludes,
  hasSessionStatus,
  sessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";
import { closeSessionTestDatabase } from "./session-launch-race-helpers.ts";

function spawnCall(
  prompt: string,
  reasoningEffort?: string,
  tools: readonly string[] = [],
  credentialId = CREDENTIAL_ID,
  agentFilePath?: string,
) {
  return toolCall("spawn_session", {
    credentialId,
    ...(agentFilePath === undefined ? {} : { agentFilePath }),
    model: "gpt-4.1-mini",
    prompt,
    provider: "openai",
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    runnerId: RUNNER_ID,
    tools,
    workingDirectory: "/work/project",
  });
}

class PausedParentChildModel implements AgentModel {
  #requestCount = 0;
  #releaseParent: (() => void) | undefined;
  readonly #resumeParent = Promise.withResolvers<undefined>();
  readonly parentPaused = new Promise<void>((resolve) => {
    this.#releaseParent = resolve;
  });

  resumeParent(): void {
    this.#resumeParent.resolve(undefined);
  }

  async complete(): Promise<AgentModelTurn> {
    this.#requestCount += 1;
    let content: string;
    let toolCalls: ReturnType<typeof spawnCall>[];
    if (this.#requestCount === 1) {
      content = "Delegating while I keep running.";
      toolCalls = [spawnCall("Complete while the parent is paused")];
    } else if (this.#requestCount === 2) {
      this.#releaseParent?.();
      await this.#resumeParent.promise;
      content = "Parent reached its safe stop boundary.";
      toolCalls = [];
    } else if (this.#requestCount === 3) {
      content = "Child final result.";
      toolCalls = [];
    } else {
      content = "Parent received the child result.";
      toolCalls = [];
    }
    return providerTurn(content, { toolCalls });
  }
}

class SelfStoppingChildModel implements AgentModel {
  childSessionId: string | undefined;
  #turn = 0;

  complete(): Promise<AgentModelTurn> {
    this.#turn += 1;
    const childSessionId = this.childSessionId;
    const turn =
      this.#turn === 1
        ? {
            content: "Delegating stoppable work.",
            toolCalls: [
              spawnCall("Stop this delegated task", undefined, [
                "stop_session",
              ]),
            ],
          }
        : this.#turn === 2
          ? { content: "Parent work is complete.", toolCalls: [] }
          : childSessionId === undefined
            ? undefined
            : {
                content: "Stopping the delegated session.",
                toolCalls: [
                  toolCall("stop_session", { sessionId: childSessionId }),
                ],
              };
    if (turn === undefined) {
      throw new Error("The child session ID is not available");
    }
    return Promise.resolve({
      ...turn,
      contextTokens: null,
      costUsd: null,
      thinking: "",
      tokenUsage: null,
    });
  }
}

interface CompletedToolOutput {
  readonly output: string | undefined;
  readonly setup: Awaited<ReturnType<typeof startToolSession>>;
}

async function completedToolOutput(
  model: AgentModel,
  name: string,
): Promise<CompletedToolOutput> {
  const { outputs, setup } = await completedParentToolOutputs(model, name);
  return { output: outputs[0], setup };
}

async function expectRejectedSpawn(
  model: AgentModel,
  expectedError: string,
  userId = TEST_USER_ID,
): Promise<void> {
  const { output, setup } = await completedToolOutput(model, "spawn_session");

  expect(output).toContain(expectedError);
  expect(setup.sessions.listForUser(userId)).toHaveLength(1);
  closeSessionTestDatabase(setup.database);
}

async function waitForRunnerSession(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  sessionId: string,
  tool?: string,
): Promise<void> {
  await waitForSessionValue(
    () => setup.runnerCommands.shift(),
    (value) =>
      isRecord(value) &&
      value["sessionId"] === sessionId &&
      (tool === undefined || value["tool"] === tool),
  );
}

async function childSessionId(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): Promise<string> {
  const parent = await completedParentDetail(setup, "idle");
  const output = findToolResultContent(parent, "spawn_session");
  const parsed: unknown = JSON.parse(output ?? "null");
  if (!isRecord(parsed) || typeof parsed["sessionId"] !== "string") {
    throw new TypeError("The spawn tool did not return a session ID");
  }
  const childId = parsed["sessionId"];
  await waitForRunnerSession(setup, childId);
  return childId;
}

async function startedChild(model: AgentModel): Promise<{
  readonly childId: string;
  readonly setup: Awaited<ReturnType<typeof startToolSession>>;
}> {
  const setup = await startToolSession(model);
  const childId = await childSessionId(setup);
  return { childId, setup };
}

async function pausedChildSetup(): Promise<{
  readonly childId: string;
  readonly model: PausedParentChildModel;
  readonly setup: Awaited<ReturnType<typeof startToolSession>>;
}> {
  const model = new PausedParentChildModel();
  const setup = await startToolSession(model);
  await model.parentPaused;
  const child = setup.sessions
    .listForUser(TEST_USER_ID)
    .find(({ parentSessionId }) => parentSessionId === SESSION_ID);
  if (child === undefined) {
    throw new Error("The paused parent child session is unavailable");
  }
  return { childId: child.id, model, setup };
}

async function completePausedChild(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  childId: string,
): Promise<void> {
  await waitForRunnerSession(setup, childId);
  completeChildAgentFile(setup);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, childId),
    hasSessionStatus("idle"),
  );
}

function completeChildAgentFile(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): void {
  completeNullRunnerCommand(setup.sessions, RUNNER_ID, RUNNER_COMMAND_ID);
}

describe("session agent tools", () => {
  test("lists and reads only the spawning user's sessions", async () => {
    const model = scriptedModel([
      {
        content: "Read this session after listing it.",
        toolCalls: [
          toolCall("list_sessions", {}),
          toolCall("read_session", { sessionId: SESSION_ID }),
        ],
      },
      { content: "Session inspection complete.", toolCalls: [] },
    ]);
    const readSetup = await startToolSession(model);
    const readDetail = await completedParentDetail(readSetup, "idle");
    expect(isRecord(readDetail)).toBe(true);

    const listed = findToolResultContent(readDetail, "list_sessions");
    expect(listed).toContain(SESSION_ID);
    const read = findToolResultContent(readDetail, "read_session");
    const readOutput = jsonRecord(read ?? "null");
    const readContent = testRecord(readOutput["content"]);
    expect(records(readContent["records"])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: "Inspect README.md", role: "user" }),
      ]),
    );
    closeSessionTestDatabase(readSetup.database);
  });

  test("routes more than eight mixed session and runner recipients through parallel", async () => {
    const toolUses = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0
        ? { parameters: {}, recipient_name: "list_sessions" }
        : {
            parameters: { sessionId: SESSION_ID },
            recipient_name: "read_session",
          },
    );
    const model = scriptedModel([
      {
        content: "Inspecting sessions in a large parallel batch.",
        toolCalls: [toolCall("parallel", { tool_uses: toolUses })],
      },
      { content: "Large parallel inspection complete.", toolCalls: [] },
    ]);
    const { output, setup } = await completedToolOutput(model, "parallel");
    const results: unknown = JSON.parse(output ?? "null");

    expect(results).toHaveLength(20);
    expect(Array.isArray(results) ? results[0] : undefined).toMatchObject({
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[19] : undefined).toMatchObject({
      recipient_name: "read_session",
    });
    expect(setup.runnerCommands).toEqual([]);
    closeSessionTestDatabase(setup.database);
  });

  test("routes session recipients in parallel without sending them to the runner", async () => {
    const model = scriptedModel([
      {
        content: "Inspecting sessions in parallel.",
        toolCalls: [
          toolCall("parallel", {
            tool_uses: [
              { parameters: {}, recipient_name: "list_sessions" },
              {
                parameters: { sessionId: SESSION_ID },
                recipient_name: "read_session",
              },
            ],
          }),
        ],
      },
      { content: "Parallel inspection complete.", toolCalls: [] },
    ]);
    const { output, setup: parallelSetup } = await completedToolOutput(
      model,
      "parallel",
    );

    expect(output).toContain("list_sessions");
    expect(output).toContain("read_session");
    expect(output).toContain('\\"role\\": \\"user\\"');
    expect(output).toContain("Inspect README.md");
    closeToolSession(parallelSetup);
  });

  test("sends to, continues, and stops owned sessions", async () => {
    const model = scriptedModel([
      {
        content: "Sending an instruction.",
        toolCalls: [
          toolCall("send_to_session", {
            message: "Handle this next",
            sessionId: "missing-session",
          }),
        ],
      },
      {
        content: "Continuing the session.",
        toolCalls: [
          toolCall("continue_session", { sessionId: "missing-session" }),
        ],
      },
      {
        content: "Stopping the session.",
        toolCalls: [toolCall("stop_session", { sessionId: SESSION_ID })],
      },
      { content: "Session controls checked.", toolCalls: [] },
    ]);
    const controlSetup = await startToolSession(model);
    const detail = await completedParentDetail(controlSetup, "stopped");

    expect(findToolResultContent(detail, "send_to_session")).toContain(
      "Session not found",
    );
    expect(findToolResultContent(detail, "continue_session")).toContain(
      "Session not found",
    );
    expect(findToolResultContent(detail, "stop_session")).toContain(
      "interrupted before it returned",
    );
    closeSessionTestDatabase(controlSetup.database);
  });

  test("accepts an absolute model agent-file path", async () => {
    const agentFilePath = "/outside/child-instructions.md";
    const model = scriptedModel([
      {
        content: "Delegate.",
        toolCalls: [
          spawnCall("Work", undefined, [], CREDENTIAL_ID, agentFilePath),
        ],
      },
      { content: "Spawned.", toolCalls: [] },
    ]);
    const { childId, setup } = await startedChild(model);

    expect(
      setup.sessions.detailForUser(TEST_USER_ID, childId)?.agentFilePath,
    ).toBe(agentFilePath);
    closeSessionTestDatabase(setup.database);
  });

  test("rejects a spawn without access to its credential", async () => {
    const model = scriptedModel([
      {
        content: "Trying another credential.",
        toolCalls: [
          spawnCall("This should not launch", undefined, [], "credential-2"),
        ],
      },
      { content: "Credential isolation confirmed.", toolCalls: [] },
    ]);
    await expectRejectedSpawn(
      model,
      "credential_unavailable",
      "018bcfe5-6800-7000-8000-000000000021",
    );
  });

  test("hands off a parent that races with server draining", async () => {
    const model = scriptedModel([
      {
        content: "Delegate during restart; it must not launch.",
        toolCalls: [spawnCall("This should not launch")],
      },
      { content: "Restart race handled.", toolCalls: [] },
    ]);
    const setup = await startToolSession(model);
    const draining = setup.sessions.drain();
    const detail = await waitForSessionValue(
      () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
      (session) =>
        typeof session === "object" &&
        session !== null &&
        "status" in session &&
        session.status === "paused",
    );

    expect(detail).toMatchObject({
      restartHandoff: { requestedBy: "server" },
      status: "paused",
    });
    await draining;
    closeSessionTestDatabase(setup.database);
  });

  test("spawns without blocking and reports the child final message later", async () => {
    const model = scriptedModel([
      {
        content: "Delegating now.",
        toolCalls: [spawnCall("Do the delegated task", "high")],
      },
      { content: "I can keep working immediately.", toolCalls: [] },
      { content: "Delegated task done.", toolCalls: [] },
    ]);
    const spawnSetup = await startToolSession(model);
    const parent = await completedParentDetail(spawnSetup, "idle");
    const spawnOutput = findToolResultContent(parent, "spawn_session");
    expect(spawnOutput).toBeDefined();

    expect(spawnOutput).toContain("sessionId");
    expect(spawnOutput).toContain("spawned");
    const childId = await childSessionId(spawnSetup);
    expect(typeof childId).toBe("string");
    completeChildAgentFile(spawnSetup);
    await waitForSessionValue(
      () =>
        spawnSetup.sessions.detailForUser(
          "018bcfe5-6800-7000-8000-000000000021",
          childId,
        ),
      hasSessionStatus("idle"),
    );
    const updatedParent = await waitForSessionValue(
      () => sessionDetail(spawnSetup.sessions),
      (value) => JSON.stringify(value).includes("Delegated task done."),
    );
    expect(JSON.stringify(updatedParent)).toContain("Delegated task done.");
    expect(JSON.stringify(updatedParent)).toContain(
      '\\"status\\": \\"completed\\"',
    );
    closeSessionTestDatabase(spawnSetup.database);
  });

  test("delivers a child result that arrives while the parent model is still running", async () => {
    const { childId, setup } = await pausedChildSetup();
    await completePausedChild(setup, childId);
    const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    expect(parent?.status).toBe("running");
    expect(parent?.pendingInputs).toHaveLength(1);
    expect(parent?.pendingInputs[0]?.content).toContain("Child final result.");
    expect(parent?.pendingInputs[0]?.kind).toBe("steer");
    closeSessionTestDatabase(setup.database);
  });

  test("gracefully stops a parent after its child result is delivered", async () => {
    const { childId, model, setup } = await pausedChildSetup();
    const stopping = setup.sessions.realtimeCommands.stopForUser(
      TEST_AUTHENTICATED_USER,
      SESSION_ID,
      true,
      TEST_WORKSPACE_ID,
    );
    let settled = false;
    void Promise.resolve(stopping).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID)?.status).toBe(
      "running",
    );

    await completePausedChild(setup, childId);
    model.resumeParent();

    await expect(stopping).resolves.toMatchObject({ status: "stopped" });
    const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    const delivered = parent?.messages.find(({ content }) => {
      return content.includes("Child final result.");
    });
    expect(delivered).toBeDefined();
    closeSessionTestDatabase(setup.database);
  });

  test("runs a parent again when its spawned child completes", async () => {
    const model = scriptedModel([
      {
        content: "Delegating before waiting.",
        toolCalls: [spawnCall("Complete the delegated task")],
      },
      { content: "Waiting for the child report.", toolCalls: [] },
      { content: "Child work is complete.", toolCalls: [] },
      { content: "I received the child report.", toolCalls: [] },
    ]);
    const setup = await startToolSession(model);
    await childSessionId(setup);
    completeChildAgentFile(setup);

    await waitForRunnerSession(setup, SESSION_ID);
    completeChildAgentFile(setup);
    const parent = await waitForSessionContent(
      setup,
      "I received the child report.",
    );
    expect(JSON.stringify(parent)).toContain("Child work is complete.");
    closeSessionTestDatabase(setup.database);
  });

  test("does not report a runner-required spawned child as completed", async () => {
    const model = scriptedModel([
      {
        content: "Delegating work.",
        toolCalls: [spawnCall("Keep working", undefined, ["bash"])],
      },
      { content: "Parent waiting.", toolCalls: [] },
      {
        content: "Child began runner work.",
        toolCalls: [toolCall("bash", { command: "sleep 30", timeout: 60 })],
      },
    ]);
    const { childId, setup } = await startedChild(model);
    completeChildAgentFile(setup);
    await waitForRunnerSession(setup, childId, "bash");

    await setup.runners.remove(
      createAuthenticatedRequest(
        `/api/runners/${RUNNER_ID}`,
        undefined,
        "DELETE",
      ),
      RUNNER_ID,
    );

    const child = setup.sessions.detailForUser(TEST_USER_ID, childId);
    expectRunnerRequired(child);
    await expectTranscriptExcludes(setup, "Spawned session completed");
    const restartedStore = new SessionStore(setup.database);
    expect(restartedStore.pendingSpawnedSessions()).toEqual([]);
    expect(restartedStore.spawnedSessionLink(TEST_USER_ID, childId)).toEqual({
      parentGeneration: 0,
      parentId: SESSION_ID,
    });
    closeSessionTestDatabase(setup.database);
  });

  test("reports a spawned child failure to its parent", async () => {
    const model = scriptedModel([
      {
        content: "Delegating work that may fail.",
        toolCalls: [spawnCall("Fail the delegated task")],
      },
      { content: "I am waiting for the report.", toolCalls: [] },
    ]);
    const failureSetup = await startToolSession(model);
    await childSessionId(failureSetup);
    completeChildAgentFile(failureSetup);

    const updatedParent = await waitForSessionContent(
      failureSetup,
      '\\"status\\": \\"failed\\"',
    );
    expect(JSON.stringify(updatedParent)).toContain(
      "The scripted model ran out of turns",
    );
    closeSessionTestDatabase(failureSetup.database);
  });

  test("reports when a spawned child stops itself", async () => {
    const model = new SelfStoppingChildModel();
    const setup = await startToolSession(model);
    const childId = await childSessionId(setup);
    model.childSessionId = childId;
    completeChildAgentFile(setup);

    const updatedParent = await waitForSessionContent(
      setup,
      '\\"status\\": \\"stopped\\"',
    );
    expect(JSON.stringify(updatedParent)).toContain(
      "interrupted before it returned",
    );
    closeSessionTestDatabase(setup.database);
  });
});
