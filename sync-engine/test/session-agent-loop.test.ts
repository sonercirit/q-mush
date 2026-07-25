import { describe, expect, test } from "vitest";
import type {
  AgentConversationCompactor,
  CompactedConversation,
} from "../../sync-engine/agent-compaction.ts";
import { runCompactingAgentLoop } from "../../sync-engine/session-agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";

const TOOL_CALL = {
  arguments: '{"path":"README.md"}',
  id: "call-1",
  name: "read",
};

type LoopOptions = Parameters<typeof runCompactingAgentLoop>[0];

function compacted(
  summary: string,
  costUsd: number | null = null,
): CompactedConversation {
  return {
    costUsd,
    messages: [{ content: summary, role: "user" }],
    summary,
    tokenUsage: null,
  };
}

function recordingCompactor(
  conversations: unknown[],
  result: (count: number) => CompactedConversation,
): () => AgentConversationCompactor {
  return () => ({
    compact: (messages) => {
      conversations.push(messages);
      return Promise.resolve(result(conversations.length));
    },
  });
}

function highTurn(content: string, contextTokens = 95_000) {
  return { content, contextTokens, toolCalls: [] };
}

function runTestLoop(
  options: Pick<LoopOptions, "createCompactor" | "model"> &
    Partial<Omit<LoopOptions, "createCompactor" | "model">>,
): Promise<void> {
  return runCompactingAgentLoop({
    agentCost: () => null,
    autoCompact: true,
    executeTool: () => Promise.reject(new Error("No tool expected")),
    initialMessages: [{ content: "Finish", role: "user" }],
    maxContextTokens: 100_000,
    recordCompaction: () => undefined,
    recordMessage: () => undefined,
    ...options,
  });
}

function triggeredModel() {
  return new ScriptedAgentModel([highTurn("Trigger compaction.")]);
}

async function expectCompactionFailure(options: {
  readonly compactor: AgentConversationCompactor;
  readonly expected: string | { readonly name: string };
  readonly recordCompaction: LoopOptions["recordCompaction"];
  readonly signal?: AbortSignal;
}): Promise<void> {
  const model = triggeredModel();
  const failure = expect(
    runTestLoop(
      options.signal === undefined
        ? {
            createCompactor: () => options.compactor,
            model,
            recordCompaction: options.recordCompaction,
          }
        : {
            createCompactor: () => options.compactor,
            model,
            recordCompaction: options.recordCompaction,
            signal: options.signal,
          },
    ),
  ).rejects;
  if (typeof options.expected === "string") {
    await failure.toThrow(options.expected);
  } else {
    await failure.toMatchObject(options.expected);
  }
  expect(model.requests).toHaveLength(1);
}

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
        contextTokens: 96_000,
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
    const modelCosts: (number | null)[] = [];

    await runCompactingAgentLoop({
      agentCost: () => null,
      autoCompact: true,
      createCompactor,
      executeTool: () => Promise.resolve("# Project"),
      initialMessages: [{ content: "Inspect the project", role: "user" }],
      maxContextTokens: 100_000,
      model,
      recordCompaction: (summary, usage) => {
        expect(usage.costBasis).toBe(
          usage.costUsd === null ? null : "reported",
        );
        costs.push(usage.costUsd);
        summaries.push(summary);
      },
      recordMessage: (_message, usage) => {
        if (usage !== undefined) {
          modelCosts.push(usage.costUsd);
        }
      },
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
    expect(costs).toEqual([0.1]);
    expect(modelCosts).toEqual([null, 0.25]);
  });

  test("compacts and continues a final turn that reaches 95%", async () => {
    const model = new ScriptedAgentModel([
      highTurn("Done before compaction."),
      highTurn("Done after compaction.", 96_000),
    ]);
    const compactedConversations: unknown[] = [];
    const summaries: string[] = [];
    const recordedMessages: unknown[] = [];
    let compactionCost = 0;
    await runTestLoop({
      createCompactor: recordingCompactor(compactedConversations, () =>
        compacted("Final handoff", 0.15),
      ),
      model,
      recordCompaction: (compactedSummary, usage) => {
        summaries.push(compactedSummary);
        compactionCost += usage.costUsd ?? 0;
      },
      recordMessage: (messages) => {
        recordedMessages.push(...messages);
      },
    });

    expect(compactedConversations).toHaveLength(1);
    expect(compactedConversations[0]).toContainEqual({
      content: "Done before compaction.",
      role: "assistant",
      toolCalls: [],
    });
    expect(model.requests).toEqual([
      [{ content: "Finish", role: "user" }],
      [{ content: "Final handoff", role: "user" }],
    ]);
    expect(summaries).toEqual(["Final handoff"]);
    expect(recordedMessages).toEqual([
      {
        content: "Done before compaction.",
        role: "assistant",
        toolCalls: [],
      },
      {
        content: "Done after compaction.",
        role: "assistant",
        toolCalls: [],
      },
    ]);
    expect(compactionCost).toBe(0.15);
  });

  test("ignores stale high usage after the compacted handoff", async () => {
    const model = new ScriptedAgentModel([
      highTurn("Before compaction."),
      highTurn("After compaction.", 96_000),
    ]);
    let compactions = 0;

    await runTestLoop({
      createCompactor: () => ({
        compact: () => {
          compactions += 1;
          return Promise.resolve(compacted("Handoff"));
        },
      }),
      model,
      recordCompaction: () => undefined,
      recordMessage: () => undefined,
    });

    expect(compactions).toBe(1);
    expect(model.requests).toHaveLength(2);
  });

  test("allows later compaction after post-handoff tool progress", async () => {
    const firstToolCall = { ...TOOL_CALL, id: "call-2" };
    const model = new ScriptedAgentModel([
      highTurn("First phase done."),
      {
        content: "Progress after the handoff.",
        contextTokens: 96_000,
        toolCalls: [firstToolCall],
      },
      highTurn("Second phase done."),
    ]);
    const summaries: string[] = [];
    const compactedConversations: unknown[] = [];
    const firstSummary = "Handoff 1";
    const secondSummary = "Handoff 2";

    await runTestLoop({
      createCompactor: recordingCompactor(compactedConversations, (count) =>
        compacted(count === 1 ? firstSummary : secondSummary),
      ),
      executeTool: () => Promise.resolve("New progress"),
      model,
      recordCompaction: (summary) => {
        summaries.push(summary);
      },
    });

    expect(compactedConversations).toHaveLength(2);
    expect(compactedConversations[1]).toContainEqual({
      content: "New progress",
      role: "tool",
      toolCallId: "call-2",
      toolName: "read",
    });
    expect(model.requests[2]).toEqual([
      { content: secondSummary, role: "user" },
    ]);
    expect(summaries).toEqual([firstSummary, secondSummary]);
  });

  test("does not persist a rejected compaction", async () => {
    const compactions: unknown[] = [];
    await expectCompactionFailure({
      compactor: {
        compact: () => Promise.reject(new Error("Compactor unavailable")),
      },
      expected: "Compactor unavailable",
      recordCompaction: (...input) => {
        compactions.push(input);
      },
    });

    expect(compactions).toEqual([]);
  });

  test("does not persist or continue an aborted compaction", async () => {
    const controller = new AbortController();
    let persisted = false;
    await expectCompactionFailure({
      compactor: {
        compact: () => {
          controller.abort();
          return Promise.resolve(compacted("Aborted handoff"));
        },
      },
      expected: { name: "AbortError" },
      recordCompaction: () => {
        persisted = true;
      },
      signal: controller.signal,
    });

    expect(persisted).toBe(false);
  });

  test("persists compaction usage through the handoff callback", async () => {
    const model = triggeredModel();
    const compactions: unknown[] = [];
    const messageUsage: unknown[] = [];

    await expect(
      runTestLoop({
        createCompactor: () => ({
          compact: () => Promise.resolve(compacted("Stored handoff", 0.25)),
        }),
        model,
        recordCompaction: (summary, compactionUsage) => {
          compactions.push({ summary, usage: compactionUsage });
          throw new Error("Stop after atomic persistence");
        },
        recordMessage: (_messages, input) => {
          if (input !== undefined) {
            messageUsage.push(input);
          }
        },
      }),
    ).rejects.toThrow("Stop after atomic persistence");

    expect(model.requests).toHaveLength(1);
    expect(compactions).toEqual([
      {
        summary: "Stored handoff",
        usage: {
          contextTokens: null,
          costBasis: "reported",
          costUsd: 0.25,
        },
      },
    ]);
    expect(messageUsage).toEqual([
      { contextTokens: 95_000, costBasis: null, costUsd: null },
    ]);
  });

  test("passes model usage with the persisted message", async () => {
    const events: unknown[] = [];

    await runTestLoop({
      createCompactor: () => ({
        compact: () => Promise.reject(new Error("No compaction expected")),
      }),
      maxContextTokens: null,
      model: new ScriptedAgentModel([
        {
          content: "Persist this provider turn.",
          contextTokens: 10,
          costUsd: 0.5,
          toolCalls: [],
        },
      ]),
      recordMessage: (_messages, usage) => {
        events.push({ type: "message", usage });
      },
    });

    expect(events).toEqual([
      {
        type: "message",
        usage: {
          contextTokens: 10,
          costBasis: "reported",
          costUsd: 0.5,
        },
      },
    ]);
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
      recordMessage: (messages, usage) => {
        if (
          messages.some((message) => message.role === "assistant") &&
          usage !== undefined
        ) {
          expect(usage.contextTokens).toBeGreaterThanOrEqual(0);
        }
      },
    });

    expect(compacted).toBe(false);
    expect(model.requests[1]?.at(0)?.content).toBe(
      "Stay in manual compaction mode",
    );
  });
});
