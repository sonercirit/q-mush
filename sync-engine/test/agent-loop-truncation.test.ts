import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModelStep,
  type AgentRecordedMessage,
  type AgentStepTruncation,
} from "../../shared/agent-loop.ts";
import { providerStep } from "./provider-step-fixtures.ts";

function truncatedStep(
  content: string,
  truncation: AgentStepTruncation,
  toolCalls: AgentModelStep["toolCalls"] = [],
): AgentModelStep {
  return { ...providerStep(content, { toolCalls }), truncation };
}

async function recordedTruncationLoop(
  steps: AgentModelStep[],
  onExecute?: (name: string) => void,
): Promise<AgentRecordedMessage[]> {
  const recorded: AgentRecordedMessage[] = [];
  await runAgentLoop({
    executeTool: (call) => {
      onExecute?.(call.name);
      return Promise.resolve("tool output");
    },
    initialMessages: [{ content: "Work", role: "user" }],
    model: {
      complete: () => {
        const step = steps.shift();
        if (step === undefined) {
          throw new Error("The scripted truncation model ran out of steps");
        }
        return Promise.resolve(step);
      },
    },
    recordMessage: (messages) => {
      recorded.push(...messages);
    },
  });
  return recorded;
}

describe("agent loop truncation notices", () => {
  test("records a durable truncation notice after a length-stopped step", async () => {
    const recorded = await recordedTruncationLoop([
      truncatedStep("Partial answer", "max_tokens"),
    ]);

    expect(recorded).toEqual([
      { content: "Partial answer", role: "assistant", toolCalls: [] },
      {
        content:
          "The response was truncated: it reached the maximum output tokens.",
        role: "error",
      },
    ]);
  });

  test("fails truncated tool calls without executing them", async () => {
    const call = { arguments: '{"path":"REA', id: "call-1", name: "read" };
    const executed: string[] = [];

    const recorded = await recordedTruncationLoop(
      [
        truncatedStep(
          "Reading before the window filled.",
          "model_context_window_exceeded",
          [call],
        ),
        providerStep("Recovered."),
      ],
      (name) => {
        executed.push(name);
      },
    );

    // A length stop can cut a tool call mid-argument, so a syntactically
    // plausible prefix must not run; each call fails with the notice and
    // the model retries with an intact conversation.
    expect(executed).toEqual([]);
    const roles = recorded.map(({ role }) => role);
    expect(roles).toEqual(["assistant", "error", "tool", "assistant"]);
    expect(recorded[1]?.content).toContain("context window");
    expect(recorded[2]).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
    });
    expect(recorded[2]?.content).toContain("truncated");
    expect(recorded[2]?.content).toContain("not executed");
  });
});
