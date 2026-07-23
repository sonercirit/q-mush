import { describe, expect, test } from "vitest";
import type { AgentConversationCompactor } from "../../sync-engine/agent-compaction.ts";
import { runCompactingAgentLoop } from "../../sync-engine/session-agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const TOOL_CALL = {
  arguments: '{"path":"README.md"}',
  id: "call-1",
  name: "read",
};

describe("compacting agent session loop", () => {
  test("automatically compacts at 95% before the next model request", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Reading the project.",
        contextTokens: 95_000,
        toolCalls: [TOOL_CALL],
      },
      {
        content: "Done after compaction.",
        contextTokens: 2_000,
        costUsd: 0.25,
        toolCalls: [],
      },
    ]);
    const compactorRequests: unknown[] = [];
    const createCompactor = (): AgentConversationCompactor => ({
      compact: (messages) => {
        compactorRequests.push(messages);
        return Promise.resolve({
          costUsd: 0.1,
          messages: [{ content: "Compacted handoff", role: "user" }],
          summary: "Compacted handoff",
          tokenUsage: null,
        });
      },
    });
    const summaries: string[] = [];
    const costs: (number | null)[] = [];

    await runCompactingAgentLoop({
      agentCost: () => null,
      autoCompact: true,
      createCompactor,
      executeTool: () => Promise.resolve("# Project"),
      initialMessages: [{ content: "Inspect the project", role: "user" }],
      maxContextTokens: 100_000,
      model,
      recordCompaction: (summary) => {
        summaries.push(summary);
      },
      recordUsage: ({ costBasis, costUsd }) => {
        expect(costBasis).toBe(costUsd === null ? null : "reported");
        costs.push(costUsd);
      },
      recordMessage: () => undefined,
    });

    expect(compactorRequests).toHaveLength(1);
    expect(compactorRequests[0]).toContainEqual({
      content: "# Project",
      role: "tool",
      toolCallId: "call-1",
      toolName: "read",
    });
    expect(compactorRequests[0]).toContainEqual({
      content: "Inspect the project",
      role: "user",
    });
    expect(model.requests[1]).toEqual([
      { content: "Compacted handoff", role: "user" },
    ]);
    expect(summaries).toContain("Compacted handoff");
    expect(costs).toEqual([null, 0.1, 0.25]);
  });

  test("compacts a final turn that reaches 95%", async () => {
    let summary = "";
    let compactionCost = 0;
    const finalCompactor: AgentConversationCompactor = {
      compact: () =>
        Promise.resolve({
          costUsd: 0.15,
          messages: [{ content: "Final handoff", role: "user" }],
          summary: "Final handoff",
          tokenUsage: null,
        }),
    };
    await runCompactingAgentLoop({
      agentCost: () => null,
      autoCompact: true,
      createCompactor: () => finalCompactor,
      executeTool: () => Promise.reject(new Error("No tool expected")),
      initialMessages: [{ content: "Finish", role: "user" }],
      maxContextTokens: 100_000,
      model: new ScriptedAgentModel([
        { content: "Done.", contextTokens: 95_000, toolCalls: [] },
      ]),
      recordCompaction: (compactedSummary) => {
        summary = compactedSummary;
      },
      recordUsage: ({ contextTokens, costUsd }) => {
        if (contextTokens !== null) {
          expect(Number.isSafeInteger(contextTokens)).toBe(true);
        }
        compactionCost += costUsd ?? 0;
      },
      recordMessage: () => undefined,
    });

    expect(summary).toBe("Final handoff");
    expect(compactionCost).toBe(0.15);
  });

  test("does not compact a full context when automatic compaction is off", async () => {
    const model = new ScriptedAgentModel([
      {
        content: "Inspecting despite high usage.",
        contextTokens: 99_000,
        toolCalls: [{ ...TOOL_CALL, id: "manual-call" }],
      },
      { content: "Manual mode done.", toolCalls: [] },
    ]);
    let compacted = false;

    await runCompactingAgentLoop({
      agentCost: () => null,
      autoCompact: false,
      createCompactor: () => ({
        compact: () => {
          compacted = true;
          throw new Error("Compaction should be disabled");
        },
      }),
      executeTool: () => Promise.resolve("# Project"),
      initialMessages: [
        { content: "Stay in manual compaction mode", role: "user" },
      ],
      maxContextTokens: 100_001,
      model,
      recordCompaction: (summary) => {
        throw new Error(`Unexpected summary: ${summary}`);
      },
      recordUsage: ({ contextTokens }) => {
        expect(contextTokens).toBeGreaterThanOrEqual(0);
      },
      recordMessage: () => undefined,
    });

    expect(compacted).toBe(false);
    expect(model.requests[1]?.at(0)?.content).toBe(
      "Stay in manual compaction mode",
    );
  });
});
