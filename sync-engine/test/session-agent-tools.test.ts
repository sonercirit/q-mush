import { describe, expect, test } from "vitest";
import type { AgentModel, AgentModelTurn } from "../../shared/agent-loop.ts";
import { isRecord } from "../../shared/auth-model.ts";
import {
  jsonRecord,
  records,
  testRecord,
} from "./session-agent-output-helpers.ts";
import { findToolResultContent } from "./session-agent-tool-helpers.ts";
import {
  completedParentDetail,
  scriptedModel,
  startToolSession,
  toolCall,
  waitForSessionContent,
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
  waitForSessionValue,
} from "./session-integration-helpers.ts";

function spawnCall(
  prompt: string,
  reasoningEffort?: string,
  tools: readonly string[] = [],
  credentialId = CREDENTIAL_ID,
) {
  return toolCall("spawn_session", {
    credentialId,
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
  return waitForSessionValue(
    () => sessionDetail(setup.sessions),
    (value) => JSON.stringify(value).includes(content),
  );
}

async function waitForRunnerSession(
  setup: Awaited<ReturnType<typeof startToolSession>>,
  sessionId: string,
): Promise<void> {
  await waitForSessionValue(
    () => setup.runnerCommands.shift(),
    (value) => isRecord(value) && value["sessionId"] === sessionId,
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

function completeChildAgentFile(
  setup: Awaited<ReturnType<typeof startToolSession>>,
): void {
  expect(
    setup.sessions.completeRunnerCommand(RUNNER_ID, RUNNER_COMMAND_ID, "null"),
  ).toBe(true);
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
    expect(output).toContain('\\"role\\": \\"user\\"');
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
    expect(
      setup.sessions.listForUser("018bcfe5-6800-7000-8000-000000000021"),
    ).toHaveLength(1);
    setup.database.$client.close();
  });

  test("rejects a spawn that races with server draining", async () => {
    const model = scriptedModel([
      {
        content: "Delegate during restart; it must not launch.",
        toolCalls: [spawnCall("This should not launch")],
      },
      { content: "Restart race handled.", toolCalls: [] },
    ]);
    const setup = await startToolSession(model);
    const draining = setup.sessions.drain();
    const detail = await waitForSessionContent(setup, "server_restarting");
    const output = findToolResultContent(detail, "spawn_session");

    expect(output).toContain("server_restarting");
    await draining;
    setup.database.$client.close();
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
    const parent = await waitForSessionContent(
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

    const updatedParent = await waitForSessionContent(
      failureSetup,
      '\\"status\\": \\"failed\\"',
    );
    expect(JSON.stringify(updatedParent)).toContain(
      "The scripted model ran out of turns",
    );
    failureSetup.database.$client.close();
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
    setup.database.$client.close();
  });
});
