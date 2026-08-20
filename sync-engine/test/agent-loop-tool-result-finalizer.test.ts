import { expect, test, vi } from "vitest";
import {
  runAgentLoop,
  type AgentMessageRecorder,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import { MINIMUM_TOOL_OUTPUT_CHARACTERS } from "../../shared/tool-limits.ts";
import {
  boundToolResult,
  unicodeCharacterCount,
} from "../../shared/tool-output-limits.ts";
import type { RunnerCommandResult } from "../../shared/tool-stream.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

interface FinalizerFixture {
  readonly arguments: string;
  readonly execute: () => Promise<RunnerCommandResult | string>;
  readonly name: string;
  readonly truncation?: "max_tokens";
}

const FINALIZER_FIXTURES: readonly FinalizerFixture[] = [
  {
    arguments: "not-json".repeat(30),
    execute: () => Promise.resolve("unexpected"),
    name: "invalid arguments",
  },
  {
    arguments: "{}",
    execute: () =>
      Promise.resolve({ output: "failure".repeat(2_000), state: "failed" }),
    name: "failed execution",
  },
  {
    arguments: "{}",
    execute: () => Promise.resolve("unexpected"),
    name: "truncated call",
    truncation: "max_tokens",
  },
];

function collectMessages(
  recorded: AgentRecordedMessage[],
): AgentMessageRecorder {
  return (messages) => {
    for (const message of messages) recorded.push(message);
  };
}

test.each(FINALIZER_FIXTURES)(
  "applies the final result bound to $name",
  async (fixture) => {
    const call = {
      arguments: fixture.arguments,
      id: `call-${fixture.name}`,
      name: "write",
    };
    const model = new ScriptedAgentModel([
      {
        content: "",
        toolCalls: [call],
        ...(fixture.truncation === undefined
          ? {}
          : { truncation: fixture.truncation }),
      },
      { content: "Recovered.", toolCalls: [] },
    ]);
    const recorded: AgentRecordedMessage[] = [];
    const finalizeToolResult = vi.fn(
      (result: RunnerCommandResult): RunnerCommandResult =>
        boundToolResult(result, {
          outputLimitCharacters: MINIMUM_TOOL_OUTPUT_CHARACTERS,
        }),
    );

    await runAgentLoop({
      executeTool: fixture.execute,
      finalizeToolResult,
      initialMessages: [{ content: "Run", role: "user" }],
      model,
      recordMessage: collectMessages(recorded),
    });

    const result = recorded.find(
      (message) => message.role === "tool" && message.toolCallId === call.id,
    );
    expect(finalizeToolResult).toHaveBeenCalledTimes(1);
    expect(finalizeToolResult).toHaveBeenCalledWith(
      expect.any(Object),
      call.name,
    );
    if (fixture.name === "invalid arguments") {
      expect(result?.content).toBe(
        "Error: the tool arguments were not a JSON object.",
      );
      expect(unicodeCharacterCount(result?.content ?? "")).toBeLessThanOrEqual(
        MINIMUM_TOOL_OUTPUT_CHARACTERS,
      );
      return;
    }
    if (fixture.truncation !== undefined) {
      expect(unicodeCharacterCount(result?.content ?? "")).toBeLessThanOrEqual(
        MINIMUM_TOOL_OUTPUT_CHARACTERS,
      );
      expect(result?.content).not.toContain("Tool output truncated");
      return;
    }
    expect(result?.content).toContain("Tool output truncated");
    expect(unicodeCharacterCount(result?.content ?? "")).toBe(
      MINIMUM_TOOL_OUTPUT_CHARACTERS,
    );
  },
);
