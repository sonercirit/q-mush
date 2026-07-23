import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModel,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { createAgentSkills } from "../../sync-engine/agent-skills.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

type ExecuteTool = Parameters<typeof runAgentLoop>[0]["executeTool"];

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
    recordUsage: ({ contextTokens }) => {
      if (contextTokens !== null) {
        recordedContextTokens.push(contextTokens);
      }
    },
    recordMessage: (message) => {
      recorded.push(message);
    },
  });
  expect(recordedContextTokens.at(-1)).toBe(expectedContextTokens);
  return recorded;
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

  test("continues until the model finishes without a turn limit", async () => {
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
      braveSearch: {
        execute: (_userId, arguments_) => {
          searchCalls.push(arguments_);
          return Promise.resolve('{"results":[]}');
        },
      },
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
});
