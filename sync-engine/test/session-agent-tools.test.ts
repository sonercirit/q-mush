import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelStep } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import { DEFAULT_TOOL_SETTINGS } from "../../shared/tool-limits.ts";
import { SessionStore } from "../../sync-engine/session-store.ts";
import {
  createAuthenticatedRequest,
  TEST_USER_ID,
} from "./authenticated-integration-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import {
  jsonRecord,
  records,
  testRecord,
} from "./session-agent-output-helpers.ts";
import {
  childSessionId,
  completeChildAgentFile,
  completeWokenParent,
  spawnCall,
  waitForChildRunnerTool,
} from "./session-agent-spawn-helpers.ts";
import {
  closeToolSession,
  findToolResultContent,
} from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  completedParentToolOutputs,
  scriptedModel,
  startToolSession,
  startToolSessionSetup,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  connectedSessionSetup,
  CREDENTIAL_ID,
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
import { emptyRuntimes } from "./session-store-test-fixtures.ts";
import { waitForTerminalParentNote } from "./session-terminal-parent-helpers.ts";

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

  async complete(): Promise<AgentModelStep> {
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
    return providerStep(content, { toolCalls });
  }
}

class SelfStoppingChildModel implements AgentModel {
  childSessionId: string | undefined;
  #step = 0;

  complete(): Promise<AgentModelStep> {
    this.#step += 1;
    const childSessionId = this.childSessionId;
    const step =
      this.#step === 1
        ? {
            content: "Delegating stoppable work.",
            toolCalls: [
              spawnCall("Stop this delegated task", undefined, [
                "stop_session",
              ]),
            ],
          }
        : this.#step === 2
          ? { content: "Parent work is complete.", toolCalls: [] }
          : this.#step === 3
            ? childSessionId === undefined
              ? undefined
              : {
                  content: "Stopping the delegated session.",
                  toolCalls: [
                    toolCall("stop_session", { sessionId: childSessionId }),
                  ],
                }
            : {
                content: "The stopped child report was received.",
                toolCalls: [],
              };
    if (step === undefined) {
      throw new Error("The child session ID is not available");
    }
    return Promise.resolve({
      ...step,
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

type StartedChild = Readonly<{
  childId: string;
  setup: Awaited<ReturnType<typeof startToolSession>>;
}>;

async function completedChildTerminalParent(
  model: AgentModel,
  onChild?: (childId: string) => void,
): Promise<StartedChild> {
  const started = await startedChild(model);
  onChild?.(started.childId);
  completeChildAgentFile(started.setup);
  await waitForTerminalParentNote(started.setup.sessions, started.childId);
  return started;
}

async function startedChild(model: AgentModel): Promise<StartedChild> {
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

function queuedChildren(
  setup: Awaited<ReturnType<typeof connectedSessionSetup>>,
) {
  return setup.sessions
    .listForUser(TEST_USER_ID)
    .filter(
      ({ parentSessionId, status }) =>
        parentSessionId === SESSION_ID && status === "queued",
    );
}

async function completePausedChild(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  childId: string,
): Promise<void> {
  await waitForChildRunnerTool(setup, childId);
  completeChildAgentFile(setup);
  await waitForSessionValue(
    () => setup.sessions.detailForUser(TEST_USER_ID, childId),
    hasSessionStatus("completed"),
  );
}

describe("agent tools", () => {
  test("lists and reads owned sessions", async () => {
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

  test("routes mixed recipients", async () => {
    const toolUses = Array.from({ length: 10 }, (_, index) =>
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

    expect(results).toHaveLength(10);
    expect(Array.isArray(results) ? results[0] : undefined).toMatchObject({
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[9] : undefined).toMatchObject({
      recipient_name: "read_session",
    });
    expect(setup.runnerCommands.length).toBe(0);
    closeSessionTestDatabase(setup.database);
  });

  test("keeps session recipients off the runner", async () => {
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

  test("controls owned sessions", async () => {
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

  test("accepts an absolute agent file", async () => {
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

  test("rejects inaccessible spawn credentials", async () => {
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

  test("queues a child during an aborted restart", async () => {
    const model = scriptedModel([
      {
        content: "Delegate at the restart boundary.",
        toolCalls: [spawnCall("This child must remain queued")],
      },
      { content: "Restart boundary handled.", toolCalls: [] },
    ]);
    const setup = connectedSessionSetup(model, "api_key", undefined, {
      onChange: (userId, sessionId) => {
        const child = setup.sessions.detailForUser(userId, sessionId);
        const preparedForParent =
          child?.parentSessionId === SESSION_ID && child.status === "queued";
        if (preparedForParent) {
          setup.sessions.abortAgentActionsForRestart?.();
        }
      },
    });
    await startToolSessionSetup(setup);
    const detail = await completedParentDetail(setup, "idle");

    expect(
      jsonRecord(findToolResultContent(detail, "spawn_session") ?? "null"),
    ).toMatchObject({ status: "queued" });
    expect(queuedChildren(setup).map(({ status }) => status)).toEqual([
      "queued",
    ]);
    expect(model.requests).toHaveLength(2);
    closeSessionTestDatabase(setup.database);
  });

  test("hands off a parent when spawn races with draining", async () => {
    const model = scriptedModel([
      {
        content: "Delegate during restart; it must not launch.",
        toolCalls: [spawnCall("This should not launch")],
      },
      { content: "Restart race handled.", toolCalls: [] },
    ]);
    let draining: Promise<void> | undefined;
    const holder: {
      setup?: Awaited<ReturnType<typeof startToolSession>>;
    } = {};
    const setup = await startToolSession(model, {
      onChange: (userId, sessionId) => {
        const child = holder.setup?.sessions.detailForUser(userId, sessionId);
        if (
          child?.parentSessionId === SESSION_ID &&
          child.status === "queued" &&
          !setup.sessions.agentActionsDraining?.()
        ) {
          draining = holder.setup?.sessions.drain();
          expect(holder.setup?.sessions.agentActionsDraining?.()).toBe(true);
        }
      },
    });
    holder.setup = setup;
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
    expect(queuedChildren(setup)).toHaveLength(1);
    expect(model.requests.length).toBeLessThanOrEqual(1);
    await draining;
    closeSessionTestDatabase(setup.database);
  });

  test("reports a spawned child later", async () => {
    const model = scriptedModel([
      {
        content: "Delegating now.",
        toolCalls: [spawnCall("Do the delegated task", "high")],
      },
      { content: "I can keep working immediately.", toolCalls: [] },
      { content: "Delegated task done.", toolCalls: [] },
      { content: "I received the delegated result.", toolCalls: [] },
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
      hasSessionStatus("completed"),
    );
    await waitForTerminalParentNote(spawnSetup.sessions, childId);
    await completeWokenParent(spawnSetup);
    const child = spawnSetup.sessions.detailForUser(TEST_USER_ID, childId);
    expect(JSON.stringify(child)).toContain("Delegated task done.");
    expect(JSON.stringify(await sessionDetail(spawnSetup.sessions))).toContain(
      "Delegated task done.",
    );
    expect(await sessionDetail(spawnSetup.sessions)).toMatchObject({
      generation: 1,
      status: "idle",
    });
    closeSessionTestDatabase(spawnSetup.database);
  });

  test("consumes steering after concurrent child completion", async () => {
    const running = await pausedChildSetup();
    const { childId, model, setup } = running;
    await completePausedChild(setup, childId);
    const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    expect(parent?.status).toBe("running");
    expect(parent?.pendingInputs).toHaveLength(1);
    expect(parent?.pendingInputs[0]?.content).toContain("Child final result.");
    expect(parent?.pendingInputs[0]?.kind).toBe("steer");

    model.resumeParent();
    const resumed = await waitForSessionValue(
      () => setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID),
      hasSessionStatus("idle"),
    );
    expect(JSON.stringify(resumed)).toContain("Child final result.");
    const pending = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    expect(pending?.pendingInputs).toHaveLength(1);
    expect(pending?.pendingInputs[0]?.content).toContain("Spawned session");
    closeSessionTestDatabase(setup.database);
  });

  test("does not wake a completed parent", async () => {
    const model = scriptedModel([
      {
        content: "Delegating before waiting.",
        toolCalls: [spawnCall("Complete the delegated task")],
      },
      { content: "Waiting for the child report.", toolCalls: [] },
      { content: "Child work is complete.", toolCalls: [] },
      { content: "I received the child report.", toolCalls: [] },
    ]);
    const { setup } = await completedChildTerminalParent(model);
    await completeWokenParent(setup);

    const parent = setup.sessions.detailForUser(TEST_USER_ID, SESSION_ID);
    expect(parent).toMatchObject({ generation: 1, status: "idle" });
    expect(JSON.stringify(parent)).toContain("Child work is complete.");
    closeSessionTestDatabase(setup.database);
  });

  test("does not report a runner-required child", async () => {
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
    await waitForChildRunnerTool(setup, childId, "bash");

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
    const restartedStore = new SessionStore(
      setup.database,
      undefined,
      () => DEFAULT_TOOL_SETTINGS,
      emptyRuntimes,
    );
    expect(restartedStore.pendingSpawnedSessions()).toEqual([]);
    expect(restartedStore.spawnedSessionLink(TEST_USER_ID, childId)).toEqual({
      parentGeneration: 0,
      parentId: SESSION_ID,
    });
    closeSessionTestDatabase(setup.database);
  });

  test("reports a self-stopping child", async () => {
    const model = new SelfStoppingChildModel();
    const { setup } = await completedChildTerminalParent(model, (childId) => {
      model.childSessionId = childId;
    });
    await completeWokenParent(setup);

    const updatedParent = setup.sessions.detailForUser(
      TEST_USER_ID,
      SESSION_ID,
    );
    expect(updatedParent?.generation).toBe(1);
    expect(updatedParent?.status).toBe("idle");
    expect(JSON.stringify(updatedParent)).toContain(
      '\\"status\\": \\"stopped\\"',
    );
    closeSessionTestDatabase(setup.database);
  });
});
