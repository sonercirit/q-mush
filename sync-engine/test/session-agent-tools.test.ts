import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import type {
  RunnerExecutionEnvironment,
  RunnerToolCommand,
} from "../../shared/runner-command-broker.ts";
import { runnerCleanupCommand } from "../../shared/test/runner-command-fixtures.ts";
import { findToolResultContent } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSession,
  toolCall,
} from "./session-agent-tool-setup.ts";
import {
  CREDENTIAL_ID,
  RUNNER_COMMAND_ID,
  RUNNER_ID,
  SESSION_ID,
} from "./session-integration-fixtures.ts";
import {
  hasSessionStatus,
  sessionDetail,
  waitForRunnerCommand,
  waitForSessionDetail,
  waitForSessionValue,
} from "./session-integration-helpers.ts";

const TEST_USER_ID = "018bcfe5-6800-7000-8000-000000000021";

function spawnCall(
  prompt: string,
  reasoningEffort?: string,
  tools: readonly string[] = [],
  credentialId = CREDENTIAL_ID,
  executionEnvironment: RunnerExecutionEnvironment = "bare_metal",
) {
  return toolCall("spawn_session", {
    credentialId,
    executionEnvironment,
    model: "gpt-4.1-mini",
    prompt,
    provider: "openai",
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    runnerId: RUNNER_ID,
    tools,
    workingDirectory: "/work/project",
  });
}

class SelfStoppingChildModel implements AgentModel {
  childSessionId: string | undefined;
  executionEnvironment: RunnerExecutionEnvironment = "bare_metal";
  #turn = 0;

  complete(): Promise<AgentModelTurn> {
    this.#turn += 1;
    const childSessionId = this.childSessionId;
    const turn =
      this.#turn === 1
        ? {
            content: "Delegating stoppable work.",
            toolCalls: [
              spawnCall(
                "Stop this delegated task",
                undefined,
                ["stop_session"],
                CREDENTIAL_ID,
                this.executionEnvironment,
              ),
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
  const setup = await startToolSession(model);
  const detail = await completedParentDetail(setup, "idle");
  return { output: findToolResultContent(detail, name), setup };
}

async function runRejectedSpawn(
  model: AgentModel,
): Promise<CompletedToolOutput> {
  return completedToolOutput(model, "spawn_session");
}

async function waitForParentContent(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  content: string,
): Promise<unknown> {
  return waitForSessionDetail(setup, (value) =>
    JSON.stringify(value).includes(content),
  );
}

async function waitForRunnerSession(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  sessionId: string,
): Promise<RunnerToolCommand> {
  const command = await waitForRunnerCommand(setup);
  if (command?.sessionId !== sessionId) {
    throw new Error("The runner session command disappeared");
  }
  return command;
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

function completeChildAgentFile(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): void {
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, RUNNER_COMMAND_ID, "null"),
  ).toBe(true);
}

function spawnModel(
  content: string,
  call: ReturnType<typeof spawnCall>,
  childContent?: string,
) {
  return scriptedModel([
    { content, toolCalls: [call] },
    { content: "Parent done.", toolCalls: [] },
    ...(childContent === undefined
      ? []
      : [{ content: childContent, toolCalls: [] }]),
  ]);
}

async function selfStoppingSetup(
  executionEnvironment: RunnerExecutionEnvironment = "bare_metal",
) {
  const model = new SelfStoppingChildModel();
  model.executionEnvironment = executionEnvironment;
  const setup = await startToolSession(model);
  const childId = await childSessionId(setup);
  model.childSessionId = childId;
  completeChildAgentFile(setup);
  return { childId, setup };
}

describe("session agent tools", () => {
  test("lists and reads only the spawning user's sessions", async () => {
    const model = scriptedModel([
      {
        content: "Checking sessions.",
        toolCalls: [toolCall("list_sessions", {})],
      },
      {
        content: "Reading this session.",
        toolCalls: [toolCall("read_session", { sessionId: SESSION_ID })],
      },
      { content: "Session inspection complete.", toolCalls: [] },
    ]);
    const readSetup = await startToolSession(model);
    const readDetail = await completedParentDetail(readSetup, "idle");
    expect(isRecord(readDetail)).toBe(true);

    const listed = findToolResultContent(readDetail, "list_sessions");
    expect(listed).toContain(SESSION_ID);
    const read = findToolResultContent(readDetail, "read_session");
    expect(read).toContain("Inspect README.md");
    readSetup.database.$client.close();
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
    setup.database.$client.close();
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
    expect(output).toContain("Inspect README.md");
    expect(parallelSetup.runnerCommands).toEqual([]);
    parallelSetup.database.$client.close();
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
    controlSetup.database.$client.close();
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
    const { output, setup } = await runRejectedSpawn(model);

    expect(output).toContain("credential_unavailable");
    expect(setup.sessions.listForUser(TEST_USER_ID)).toHaveLength(1);
    setup.database.$client.close();
  });

  test("rejects a spawn that races with server draining", async () => {
    const model = spawnModel(
      "Delegating during restart.",
      spawnCall("This should not launch"),
    );
    const setup = await startToolSession(model);
    const draining = setup.sessions.drain();
    const detail = await completedParentDetail(setup, "idle");
    const output = findToolResultContent(detail, "spawn_session");

    expect(output).toContain("server_restarting");
    await draining;
    setup.database.$client.close();
  });

  test("persists the spawned session execution environment", async () => {
    const model = spawnModel(
      "Delegating isolated work.",
      spawnCall(
        "Run the isolated task",
        undefined,
        [],
        CREDENTIAL_ID,
        "container",
      ),
      "Child done.",
    );
    const setup = await startToolSession(model);
    const childId = await childSessionId(setup);

    const child = setup.sessions.detailForUser(TEST_USER_ID, childId);
    setup.database.$client.close();
    expect(child?.executionEnvironment).toBe("container");
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
      () => spawnSetup.sessions.detailForUser(TEST_USER_ID, childId),
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
    spawnSetup.database.$client.close();
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
    const parent = await waitForParentContent(
      setup,
      "I received the child report.",
    );
    expect(JSON.stringify(parent)).toContain("Child work is complete.");
    setup.database.$client.close();
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

    const updatedParent = await waitForParentContent(
      failureSetup,
      '\\"status\\": \\"failed\\"',
    );
    expect(JSON.stringify(updatedParent)).toContain(
      "The scripted model ran out of turns",
    );
    failureSetup.database.$client.close();
  });

  test("reports when a spawned child stops itself", async () => {
    const { setup } = await selfStoppingSetup();

    const updatedParent = await waitForParentContent(
      setup,
      '\\"status\\": \\"stopped\\"',
    );
    expect(JSON.stringify(updatedParent)).toContain(
      "interrupted before it returned",
    );
    setup.database.$client.close();
  });

  test("cleans a container after a spawned child stops itself", async () => {
    const { childId, setup } = await selfStoppingSetup("container");

    const cleanup = await waitForRunnerSession(setup, childId);
    expect(cleanup).toMatchObject(runnerCleanupCommand());
    expect(
      setup.sessions.completeRunnerCommand(
        RUNNER_ID,
        cleanup.id,
        "Container removed.",
      ),
    ).toBe(true);
    await waitForParentContent(setup, '\\"status\\": \\"stopped\\"');
    setup.database.$client.close();
  });
});
