import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModel,
  type AgentModelStep,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { expectCompleteParallelPayload } from "../../shared/test/parallel-fixtures.ts";
import { createAgentSkills } from "../../sync-engine/agent-skills.ts";
import { registerParallelSkillExecutionTests } from "./agent-parallel-skill-test-suite.ts";
import { testBraveSearchSkill } from "./agent-skill-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  abortedSignal,
  deferredHandoff,
  expectAborted,
  recordingPersistence,
  requestHandoff,
  terminalPersistence,
} from "./session-agent-loop-test-helpers.ts";
import { promiseGate, type PromiseGate } from "./session-race-test-helpers.ts";

type ExecuteTool = Parameters<typeof runAgentLoop>[0]["executeTool"];
type RecordMessage = Parameters<typeof runAgentLoop>[0]["recordMessage"];

async function runRecordedLoop(
  model: AgentModel,
  prompt: string,
  executeTool: ExecuteTool,
  expectedContextTokens?: number,
): Promise<AgentRecordedMessage[]> {
  const recordedContextTokens: number[] = [];
  const recorded: AgentRecordedMessage[] = [];
  await runAgentLoop({
    executeTool,
    initialMessages: [{ content: prompt, role: "user" }],
    model,
    recordMessage: (messages, usage) => {
      recorded.push(...messages);
      if (usage?.contextTokens !== null && usage?.contextTokens !== undefined) {
        recordedContextTokens.push(usage.contextTokens);
      }
    },
  });
  expect(recordedContextTokens.at(-1)).toBe(expectedContextTokens);
  return recorded;
}

function emptyToolCall(
  id: string,
  name: string,
): AgentModelStep["toolCalls"][number] {
  return { arguments: "{}", id, name };
}

function completedStep(content: string): AgentModelStep {
  return providerStep(content);
}

function toolMessage(
  id: string,
  name: string,
  content = `${id} complete`,
): AgentRecordedMessage {
  return {
    content,
    role: "tool",
    toolCallId: id,
    toolName: name,
  };
}

function persistenceGate(
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
  wait: (messages: Parameters<RecordMessage>[0]) => boolean,
): RecordMessage {
  return recordingPersistence(gate, recorded, wait);
}

function toolPersistenceGate(
  id: string,
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
): RecordMessage {
  return persistenceGate(
    gate,
    recorded,
    (messages) =>
      messages.find(
        (message) => message.role === "tool" && message.toolCallId === id,
      ) !== undefined,
  );
}

function terminalPersistenceRecorder(
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
): RecordMessage {
  return terminalPersistence(gate, recorded);
}

function runHandoffLoop(
  model: AgentModel,
  handoffRequested: () => boolean,
  executeTool: ExecuteTool,
  recordMessage: RecordMessage = () => undefined,
) {
  return runAgentLoop({
    executeTool,
    handoffRequested,
    initialMessages: [{ content: "Work", role: "user" }],
    model,
    recordMessage,
  });
}

describe("first-party agent loop", () => {
  test("runs model-requested tools and returns their output to the model", async () => {
    const readCall = {
      arguments: '{"path":"README.md"}',
      id: "call-1",
      name: "read",
    };
    const assistantMessage = {
      content: "I will inspect the project.",
      role: "assistant" as const,
      toolCalls: [readCall],
    };
    const toolMessage = {
      content: "# Q Mush",
      role: "tool" as const,
      toolCallId: "call-1",
      toolName: "read",
    };
    const model = new ScriptedAgentModel([
      {
        content: "I will inspect the project.",
        contextTokens: 12_000,
        thinking: "I should read the project documentation first.",
        toolCalls: assistantMessage.toolCalls,
      },
      {
        content: "The project is ready.",
        contextTokens: 13_000,
        toolCalls: [],
      },
    ]);
    const executed: string[] = [];
    const recorded = await runRecordedLoop(
      model,
      "Inspect this project",
      (call) => {
        executed.push(`${call.name}:${String(call.arguments["path"])}`);
        return Promise.resolve("# Q Mush");
      },
      13_000,
    );

    expect(executed).toEqual(["read:README.md"]);
    expect(recorded).toEqual([
      {
        content: "I should read the project documentation first.",
        role: "thinking",
      },
      assistantMessage,
      toolMessage,
      { content: "The project is ready.", role: "assistant", toolCalls: [] },
    ]);
    expect(model.requests[1]).toContainEqual(toolMessage);
    expect(model.requests[1]?.[0]).toMatchObject({
      role: "user",
    });
  });

  test("persists every tool result before handing off at a safe boundary", async () => {
    const toolCalls = [
      emptyToolCall("call-1", "read"),
      emptyToolCall("call-2", "bash"),
    ];
    const model = new ScriptedAgentModel([
      { content: "Running tools.", toolCalls },
      { content: "This step must wait for recovery.", toolCalls: [] },
    ]);
    const firstToolPersistence = promiseGate();
    const recorded: AgentRecordedMessage[] = [];
    const handoff = deferredHandoff();
    const persistFirstTool = toolPersistenceGate(
      "call-1",
      firstToolPersistence,
      recorded,
    );

    const loop = runHandoffLoop(
      model,
      handoff.isRequested,
      (call) => Promise.resolve(`${call.id} complete`),
      persistFirstTool,
    );

    await firstToolPersistence.entered;
    expect(recorded.map(({ role }) => role)).toEqual(["assistant"]);
    handoff.request();
    firstToolPersistence.release(undefined);

    const result = await loop;

    expect(result.status).toBe("handoff");
    expect(model.requests).toHaveLength(1);
    expect(recorded).toEqual([
      { content: "Running tools.", role: "assistant", toolCalls },
      toolMessage("call-1", "read"),
      toolMessage("call-2", "bash"),
    ]);
  });

  test("completes when restart becomes pending during final persistence", async () => {
    const persistence = promiseGate();
    const terminalModel = completedStep("Durable response.");
    const model = new ScriptedAgentModel([terminalModel]);
    const persistedMessages: AgentRecordedMessage[] = [];
    const handoff = deferredHandoff();
    const loop = runHandoffLoop(
      model,
      handoff.isRequested,
      () => Promise.reject(new Error("No tool expected")),
      terminalPersistenceRecorder(persistence, persistedMessages),
    );

    expect(persistedMessages).toEqual([]);
    await requestHandoff(persistence, handoff.request);

    await expect(loop).resolves.toMatchObject({
      messages: [
        { content: "Work", role: "user" },
        { content: "Durable response.", role: "assistant", toolCalls: [] },
      ],
      status: "complete",
    });
    expect(persistedMessages).toEqual([
      { content: "Durable response.", role: "assistant", toolCalls: [] },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  test("an abort outranks a simultaneously requested handoff", async () => {
    const model: AgentModel = {
      complete: () => Promise.reject(new Error("Model request was unexpected")),
    };
    await expectAborted(
      runAgentLoop({
        executeTool: () => Promise.resolve("Tool request was unexpected"),
        handoffRequested: () => true,
        initialMessages: [],
        model,
        recordMessage: () => undefined,
        signal: abortedSignal(),
      }),
    );
  });

  test("prepares the conversation immediately before a model request", async () => {
    const model = new ScriptedAgentModel([
      { content: "Prepared.", toolCalls: [] },
    ]);
    let preparations = 0;

    await runAgentLoop({
      executeTool: () => Promise.resolve(""),
      initialMessages: [{ content: "Original", role: "user" }],
      model,
      prepareMessages: (messages) => {
        preparations += 1;
        expect(messages).toEqual([{ content: "Original", role: "user" }]);
        return [{ content: "Prepared context", role: "user" }];
      },
      recordMessage: () => undefined,
    });

    expect(preparations).toBe(1);
    expect(model.requests[0]).toEqual([
      { content: "Prepared context", role: "user" },
    ]);
  });

  test("continues until the model finishes without a step limit", async () => {
    const toolTurns = Array.from({ length: 33 }, (_, index) => ({
      content: "",
      toolCalls: [
        {
          arguments: "{}",
          id: `call-${String(index)}`,
          name: "bash",
        },
      ],
    }));
    const model = new ScriptedAgentModel([
      ...toolTurns,
      { content: "Long-running task complete.", toolCalls: [] },
    ]);
    const executedCallIds: string[] = [];

    const recorded = await runRecordedLoop(
      model,
      "Complete a long task",
      (call) => {
        executedCallIds.push(call.id);
        return Promise.resolve("Tool complete.");
      },
    );

    expect(executedCallIds).toHaveLength(33);
    expect(recorded.at(-1)).toMatchObject({
      content: "Long-running task complete.",
      role: "assistant",
    });
  });

  test("reports malformed tool arguments to the model without executing them", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "",
        toolCalls: [{ arguments: "not-json", id: "bad-call", name: "write" }],
      },
      { content: "I corrected the request.", toolCalls: [] },
    ]);
    let executionCount = 0;
    const recorded = await runRecordedLoop(model, "Make a change", () => {
      executionCount += 1;
      return Promise.resolve("");
    });

    expect(executionCount).toBe(0);
    expect(recorded[1]).toEqual({
      content: "Error: the tool arguments were not a JSON object.",
      role: "tool",
      toolCallId: "bad-call",
      toolName: "write",
    });
  });

  test("executes server-side skills without dispatching them to a runner", async () => {
    const runnerCalls: string[] = [];
    const searchCalls: Readonly<Record<string, unknown>>[] = [];

    const skills = createAgentSkills({
      braveSearch: testBraveSearchSkill((arguments_) => {
        searchCalls.push(arguments_);
        return Promise.resolve('{"results":[]}');
      }),
      executeTool: (name) => {
        runnerCalls.push(name);
        return Promise.resolve("runner result");
      },
      tools: ["brave_search"],
      userId: "user-id",
    });
    const model = new ScriptedAgentModel([
      {
        content: "I will search the web.",
        toolCalls: [
          {
            arguments: '{"query":"Bun documentation"}',
            id: "search-call",
            name: "brave_search",
          },
        ],
      },
      { content: "Search complete.", toolCalls: [] },
    ]);

    await runRecordedLoop(model, "Research Bun", (call) => {
      const skill = skills.execute(call.name, call.arguments);

      if (skill !== undefined) {
        return skill;
      }

      runnerCalls.push(call.name);
      return Promise.resolve("runner result");
    });

    expect(searchCalls).toEqual([{ query: "Bun documentation" }]);
    expect(runnerCalls).toEqual([]);
  });

  registerParallelSkillExecutionTests(
    null,
    (output) => {
      expectCompleteParallelPayload(output, "x".repeat(60 * 1_024));
    },
    "keeps complete parallel skill output for the shared final bound",
  );
});
