import { describe, expect, test } from "bun:test";
import { runAgentLoop, type AgentConversationMessage } from "../agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

type ExecuteTool = Parameters<typeof runAgentLoop>[0]["executeTool"];

async function runRecordedLoop(
  model: ScriptedAgentModel,
  prompt: string,
  executeTool: ExecuteTool,
): Promise<AgentConversationMessage[]> {
  const recorded: AgentConversationMessage[] = [];
  await runAgentLoop({
    executeTool,
    initialMessages: [{ content: prompt, role: "user" }],
    model,
    recordMessage: (message) => {
      recorded.push(message);
    },
  });
  return recorded;
}

describe("first-party agent loop", () => {
  test("runs model-requested tools and returns their output to the model", async () => {
    const readCall = {
      arguments: '{"path":"README.md"}',
      id: "call-1",
      name: "read_file",
    };
    const model = new ScriptedAgentModel([
      {
        content: "I will inspect the project.",
        toolCalls: [readCall],
      },
      { content: "The project is ready.", toolCalls: [] },
    ]);
    const executed: string[] = [];
    const recorded = await runRecordedLoop(
      model,
      "Inspect this project",
      (call) => {
        executed.push(`${call.name}:${String(call.arguments["path"])}`);
        return Promise.resolve("# Q Mush");
      },
    );

    expect(executed).toEqual(["read_file:README.md"]);
    expect(recorded).toEqual([
      {
        content: "I will inspect the project.",
        role: "assistant",
        toolCalls: [readCall],
      },
      {
        content: "# Q Mush",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
      },
      { content: "The project is ready.", role: "assistant", toolCalls: [] },
    ]);
    expect(model.requests[1]).toEqual([
      { content: "Inspect this project", role: "user" },
      ...recorded.slice(0, 2),
    ]);
  });

  test("reports malformed tool arguments to the model without executing them", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "",
        toolCalls: [
          { arguments: "not-json", id: "bad-call", name: "write_file" },
        ],
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
      toolName: "write_file",
    });
  });
});
