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
      executeTool: (name) => {
        runnerCalls.push(name);
        return Promise.resolve({ output: "runner result", state: "completed" });
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

  test("executes mixed parallel tools and skills without dispatching the wrapper", async () => {
    const searchCalls: Readonly<Record<string, unknown>>[] = [];
    const runnerCalls: string[] = [];
    const completions: string[] = [];
    let releaseSearch: (() => void) | undefined;
    let releaseTool: (() => void) | undefined;
    const braveSearch = {
      execute: (
        _userId: string,
        arguments_: Readonly<Record<string, unknown>>,
      ) => {
        searchCalls.push(arguments_);
        return new Promise<string>((resolve) => {
          releaseSearch = () => {
            completions.push("brave_search");
            resolve(JSON.stringify(arguments_));
          };
        });
      },
    };
    const skills = createAgentSkills({
      braveSearch,
      executeTool: (name, arguments_) => {
        runnerCalls.push(name);
        return new Promise((resolve) => {
          releaseTool = () => {
            completions.push(name);
            resolve({
              output: JSON.stringify(arguments_),
              state: "completed",
            });
          };
        });
      },
      tools: ["read", "parallel", "brave_search"],
      userId: "user-id",
    });

    const output = skills.execute("parallel", {
      tool_uses: [
        {
          parameters: { query: "Bun" },
          recipient_name: "brave_search",
        },
        {
          parameters: { path: "README.md" },
          recipient_name: "read",
        },
      ],
    });

    expect(searchCalls).toEqual([{ query: "Bun" }]);
    expect(runnerCalls).toEqual(["read"]);
    releaseTool?.();
    await Promise.resolve();
    expect(completions).toEqual(["read"]);
    releaseSearch?.();
    const result = await output;
    expect(JSON.parse(result?.output ?? "null")).toEqual([
      {
        output: '{"query":"Bun"}',
        recipient_name: "brave_search",
      },
      {
        output: '{"path":"README.md"}',
        recipient_name: "read",
      },
    ]);
    expect(result?.state).toBe("completed");
  });

  test("rejects disabled recipients inside parallel calls", async () => {
    let searchCalled = false;
    let runnerCall: string | undefined;
    const skills = createAgentSkills({
      braveSearch: {
        execute: () => {
          searchCalled = true;
          return Promise.resolve("unexpected search result");
        },
      },
      executeTool: (name) => {
        runnerCall = name;
        return Promise.resolve({
          output: "enabled runner result",
          state: "completed",
        });
      },
      tools: ["read", "parallel"],
      userId: "user-id",
    });

    const output = await skills.execute("parallel", {
      tool_uses: [
        { parameters: { path: "README.md" }, recipient_name: "read" },
        { parameters: { query: "disabled" }, recipient_name: "brave_search" },
      ],
    });

    expect(searchCalled).toBe(false);
    expect(runnerCall).toBe("read");
    expect(JSON.parse(output?.output ?? "null")).toEqual([
      { output: "enabled runner result", recipient_name: "read" },
      {
        output: "Error: brave_search is not enabled for this session.",
        recipient_name: "brave_search",
      },
    ]);
    expect(output?.state).toBe("failed");
  });
});
