import { expect, test } from "vitest";
import type { AgentModel } from "../../shared/agent-loop.ts";
import { runCompactingAgentLoop } from "../session-agent-loop.ts";

function unexpected(message: string): Promise<never> {
  return Promise.reject(new Error(message));
}

test("does not request a model when recovered input ends in assistant output", async () => {
  const assistant = {
    content: "Already complete.",
    role: "assistant" as const,
    toolCalls: [],
  };
  const model: AgentModel = {
    complete: () => unexpected("Model request was unexpected"),
  };
  const createCompactor = () => ({
    compact: () => unexpected("Compaction was unexpected"),
  });

  await expect(
    runCompactingAgentLoop({
      agentCost: () => null,
      autoCompact: false,
      createCompactor,
      executeTool: () => unexpected("Tool was unexpected"),
      initialMessages: [{ content: "Finish this", role: "user" }, assistant],
      maxContextTokens: null,
      model,
      now: () => 0,
      recordCompaction: () => undefined,
      recordMessage: () => undefined,
    }),
  ).resolves.toBe("complete");
});
