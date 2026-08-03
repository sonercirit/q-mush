import { describe, expect, test } from "vitest";
import type {
  AgentConversationCompactor,
  CompactedConversation,
} from "../../sync-engine/agent-compaction.ts";
import { runCompactingAgentLoop } from "../../sync-engine/session-agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  abortedSignal,
  compacted,
  countedCompactor,
  deferredHandoff,
  expectAborted,
  expectCompactionFailure,
  expectCompletedHandoff,
  expectLoopCounts,
  highStep,
  type LoopOptions,
  recordingCompactor,
  recordingMessages,
  recordingToolPersistence,
  runTestLoop,
  STEP_TOKEN_USAGE,
  terminalPersistence,
  TOOL_CALL,
  toolMessage,
  triggeredModel,
} from "./session-agent-loop-test-helpers.ts";
import { promiseGate } from "./session-race-test-helpers.ts";

function recoveredModel(content = "Must wait for explicit recovery.") {
  return new ScriptedAgentModel([{ content, toolCalls: [] }]);
}

function recordedToolTurn(toolCalls: readonly unknown[]) {
  return { content: "Finish these tools.", role: "assistant", toolCalls };
}

function expectNoCompaction(
  compactorRequests: number,
  model: ScriptedAgentModel,
): void {
  expect(compactorRequests).toBe(0);
  expect(model.requests).toHaveLength(0);
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
          contextTokens: null,
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
      now: Date.now,
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

  test("compacts and continues a final step that reaches 95%", async () => {
    const model = new ScriptedAgentModel([
      highStep("Done before compaction."),
      highStep("Done after compaction.", 96_000),
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
      recordMessage: recordingMessages(recordedMessages),
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
      highStep("Before compaction."),
      highStep("After compaction.", 96_000),
    ]);
    let compactions = 0;

    await runTestLoop({
      createCompactor: countedCompactor(() => {
        compactions += 1;
      }, "Handoff"),
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
      highStep("First phase done."),
      {
        content: "Progress after the handoff.",
        contextTokens: 96_000,
        toolCalls: [firstToolCall],
      },
      highStep("Second phase done."),
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

  test("compacts durable recovered context before the first model request", async () => {
    const initialMessages: LoopOptions["initialMessages"] = [
      { content: "Work", role: "user" },
      {
        content: "Reading before restart.",
        role: "assistant",
        toolCalls: [TOOL_CALL],
      },
      toolMessage(TOOL_CALL.id, "Durable tool result"),
    ];
    const model = new ScriptedAgentModel([
      { content: "Recovered after compaction.", toolCalls: [] },
    ]);
    const compactedConversations: unknown[] = [];

    await expect(
      runTestLoop({
        createCompactor: recordingCompactor(compactedConversations, () =>
          compacted("Recovered durable handoff"),
        ),
        initialContextTokens: 95_000,
        initialMessages,
        model,
      }),
    ).resolves.toBe("complete");

    expect(compactedConversations).toEqual([initialMessages]);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.[0]?.content).toContain(
      "Recovered durable handoff",
    );
  });

  test("hands off before durable recovered pre-request compaction", async () => {
    const model = recoveredModel();
    let compactorRequests = 0;

    await expect(
      runTestLoop({
        createCompactor: countedCompactor(() => {
          compactorRequests += 1;
        }),
        handoffRequested: () => true,
        initialContextTokens: 95_000,
        model,
      }),
    ).resolves.toBe("handoff");

    expectNoCompaction(compactorRequests, model);
  });

  test("completes when restart becomes pending during durable pre-request compaction", async () => {
    const persistence = promiseGate();

    const model = recoveredModel();
    const handoff = deferredHandoff();
    const compactionRequestCount = { value: 0 };
    const loop = runTestLoop({
      createCompactor: countedCompactor(() => {
        compactionRequestCount.value += 1;
      }, "Durable recovered handoff"),
      handoffRequested: handoff.isRequested,
      initialContextTokens: 95_000,
      model,
      recordCompaction: async () => {
        await persistence.wait();
      },
    });

    await expectCompletedHandoff(persistence, handoff, loop);
    expectLoopCounts(compactionRequestCount.value, model, 1, 0);
  });

  test("does not pre-compact recovered context below the threshold", async () => {
    const model = new ScriptedAgentModel([
      { content: "Recovered normally.", toolCalls: [] },
    ]);
    let compactorRequests = 0;

    await runTestLoop({
      createCompactor: countedCompactor(() => {
        compactorRequests += 1;
      }),
      initialContextTokens: 94_999,
      model,
    });

    expectLoopCounts(compactorRequests, model, 0, 1);
  });

  test("an abort outranks a simultaneously requested handoff", async () => {
    const compactor: AgentConversationCompactor = {
      compact: () => Promise.reject(new Error("Compaction was unexpected")),
    };

    await expectAborted(
      runTestLoop({
        createCompactor: () => compactor,
        handoffRequested: () => true,
        model: new ScriptedAgentModel([]),
        signal: abortedSignal(),
      }),
    );
  });

  test("hands off a tool step before pending compaction or another model request", async () => {
    const toolCalls = [TOOL_CALL, { ...TOOL_CALL, id: "call-2" }];
    const model = new ScriptedAgentModel([
      {
        content: "Finish these tools.",
        contextTokens: 95_000,
        toolCalls,
      },
      highStep("Must wait for restart recovery."),
    ]);
    const toolPersistence = promiseGate();
    const recordedMessages: unknown[] = [];
    let compactorRequests = 0;

    const handoff = deferredHandoff();
    const loop = runTestLoop({
      createCompactor: countedCompactor(() => {
        compactorRequests += 1;
      }, "Unexpected compaction"),
      executeTool: (call) => Promise.resolve(`${call.id} complete`),
      handoffRequested: handoff.isRequested,
      model,
      recordMessage: recordingToolPersistence(
        toolPersistence,
        recordedMessages,
      ),
    });

    await toolPersistence.entered;
    expect(recordedMessages).toEqual([recordedToolTurn(toolCalls)]);
    handoff.request();
    toolPersistence.release(undefined);

    await expect(loop).resolves.toBe("handoff");
    expect(recordedMessages).toEqual([
      recordedToolTurn(toolCalls),
      toolMessage("call-1"),
      toolMessage("call-2"),
    ]);

    expectLoopCounts(compactorRequests, model, 0, 1);
  });

  test("completes when restart becomes pending during durable terminal persistence", async () => {
    const persistence = promiseGate();
    const model = new ScriptedAgentModel([
      highStep("Persisted terminal response."),
      highStep("Must not run after restart."),
    ]);
    const compactedConversations: unknown[] = [];
    const recordedMessages: unknown[] = [];
    const handoff = deferredHandoff();
    const loop = runTestLoop({
      createCompactor: recordingCompactor(compactedConversations, () =>
        compacted("Persisted terminal handoff"),
      ),
      handoffRequested: handoff.isRequested,
      model,
      recordMessage: terminalPersistence(persistence, recordedMessages),
    });

    expect(recordedMessages).toEqual([]);
    await expectCompletedHandoff(persistence, handoff, loop);
    expect(recordedMessages).toEqual([
      {
        content: "Persisted terminal response.",
        role: "assistant",
        toolCalls: [],
      },
    ]);
    expect(compactedConversations).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  test("completes when restart becomes pending during terminal compaction", async () => {
    const compactor = promiseGate<CompactedConversation>();
    const compactionPersistence = promiseGate();
    const model = new ScriptedAgentModel([
      highStep("Durable terminal response."),
      highStep("Must not run after restart."),
    ]);
    const recordedMessages: unknown[] = [];
    const recordedCompactions: string[] = [];
    let handoffRequested = false;
    let compactorRequests = 0;
    const loop = runTestLoop({
      createCompactor: () => ({
        compact: () => {
          compactorRequests += 1;
          return compactor.wait();
        },
      }),
      handoffRequested: () => handoffRequested,
      model,
      recordCompaction: async (summary) => {
        await compactionPersistence.wait();

        recordedCompactions.push(summary);
      },
      recordMessage: recordingMessages(recordedMessages),
    });

    await compactor.entered;
    expect(recordedMessages).toEqual([
      {
        content: "Durable terminal response.",
        role: "assistant",
        toolCalls: [],
      },
    ]);
    compactor.release(compacted("Durable restart handoff"));
    await compactionPersistence.entered;
    expect(recordedCompactions).toEqual([]);
    handoffRequested = true;

    compactionPersistence.release(undefined);

    await expect(loop).resolves.toBe("complete");

    expect(recordedCompactions).toEqual(["Durable restart handoff"]);

    expectLoopCounts(compactorRequests, model, 1, 1);
  });

  test("does not persist and does settle a rejected compaction", async () => {
    const compactions: unknown[] = [];
    let settled = false;
    await expectCompactionFailure({
      compactor: {
        compact: () => Promise.reject(new Error("Compactor unavailable")),
      },
      expected: "Compactor unavailable",
      recordCompaction: (...input) => {
        compactions.push(input);
      },
      settleCompaction: () => {
        settled = true;
      },
    });

    expect(compactions).toEqual([]);
    expect(settled).toBe(true);
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
    const compactionStartedAt = Date.UTC(2026, 6, 30, 12);

    await expect(
      runTestLoop({
        createCompactor: () => ({
          compact: () =>
            Promise.resolve({
              ...compacted("Stored handoff", 0.25),
              contextTokens: 97_500,
            }),
        }),
        model,
        now: () => compactionStartedAt,
        recordCompaction: (summary, compactionUsage, startedAt) => {
          compactions.push({ startedAt, summary, usage: compactionUsage });
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
        startedAt: compactionStartedAt,
        summary: "Stored handoff",
        usage: {
          contextTokens: 97_500,
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
          content: "Persist this provider step.",
          contextTokens: 10,
          costUsd: 0.5,
          tokenUsage: STEP_TOKEN_USAGE,
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
          tokenUsage: STEP_TOKEN_USAGE,
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
      now: Date.now,
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
