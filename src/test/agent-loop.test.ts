import { describe, expect, test } from "bun:test";
import { runAgentLoop, type AgentRecordedMessage } from "../agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

type ExecuteTool = Parameters<typeof runAgentLoop>[0]["executeTool"];

async function runRecordedLoop(
  model: ScriptedAgentModel,
  prompt: string,
  executeTool: ExecuteTool,
): Promise<AgentRecordedMessage[]> {
  const recorded: AgentRecordedMessage[] = [];
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
        content: assistantMessage.content,
        thinking: "I should read the project documentation first.",
        toolCalls: assistantMessage.toolCalls,
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
    expect(model.requests[1]).toEqual([
      { content: "Inspect this project", role: "user" },
      assistantMessage,
      toolMessage,
    ]);
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
});
