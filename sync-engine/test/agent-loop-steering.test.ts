import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModel,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { providerTurn } from "./provider-turn-fixtures.ts";

function takeSteeringMessage(content: string) {
  let pending = true;
  return () => {
    if (!pending) return [];

    pending = false;
    return [{ content, role: "user" as const }];
  };
}

function recordingModel(
  requests: unknown[][],
  complete: (requestCount: number) => ReturnType<AgentModel["complete"]>,
): AgentModel {
  return {
    complete: (messages) => {
      requests.push([...messages]);
      return complete(requests.length);
    },
  };
}

async function runSteeringLoop(options: {
  readonly executeOutput: string;
  readonly model: AgentModel;
  readonly recordMessage?: (messages: readonly AgentRecordedMessage[]) => void;
  readonly steering: string;
}): Promise<void> {
  await runAgentLoop({
    executeTool: () => Promise.resolve(options.executeOutput),
    initialMessages: [{ content: "Initial task", role: "user" }],
    model: options.model,
    recordMessage: options.recordMessage ?? (() => undefined),
    takeSteeringMessages: takeSteeringMessage(options.steering),
  });
}

describe("agent-loop steering boundaries", () => {
  test("consumes steering after tool results before the next model request", async () => {
    const requests: unknown[][] = [];
    const turns = [
      providerTurn("Inspecting.", {
        toolCalls: [{ arguments: "{}", id: "call-1", name: "read" }],
      }),
      providerTurn("Done."),
    ];
    const recorded: AgentRecordedMessage[] = [];
    await runSteeringLoop({
      executeOutput: "Tool output",
      model: recordingModel(requests, () => {
        const next = turns.shift();
        if (next === undefined) throw new Error("Unexpected model request");
        return Promise.resolve(next);
      }),
      recordMessage: (messages) => {
        recorded.push(...messages);
      },
      steering: "Change direction",
    });
    expect(requests[1]).toEqual([
      { content: "Initial task", role: "user" },
      {
        content: "Inspecting.",
        role: "assistant",
        toolCalls: [{ arguments: "{}", id: "call-1", name: "read" }],
      },
      {
        content: "Tool output",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read",
      },
      { content: "Change direction", role: "user" },
    ]);
    expect(recorded.at(-1)).toMatchObject({ content: "Done." });
  });

  test("continues a terminal model turn when steering arrives at its safe boundary", async () => {
    const requests: unknown[][] = [];
    await runSteeringLoop({
      executeOutput: "unused",
      model: recordingModel(requests, (requestCount) =>
        Promise.resolve(
          providerTurn(requestCount === 1 ? "First answer" : "Steered answer"),
        ),
      ),
      steering: "One more thing",
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContainEqual({
      content: "One more thing",
      role: "user",
    });
  });
});
