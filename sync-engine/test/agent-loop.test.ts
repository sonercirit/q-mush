import { describe, expect, test } from "vitest";
import {
  runAgentLoop,
  type AgentModel,
  type AgentModelStep,
  type AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import {
  createParallelToolUses,
  expectCompleteParallelPayload,
} from "../../shared/test/parallel-fixtures.ts";
import { createAgentSkills } from "../../sync-engine/agent-skills.ts";
import { captureRejection } from "./promise-test-helpers.ts";
import { providerStep } from "./provider-step-fixtures.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import {
  abortedSignal,
  deferredHandoff,
  expectAborted,
  recordingPersistence,
  requestHandoff,
  terminalPersistence,
} from "./session-agent-loop-test-helpers.ts";
import { promiseGate, type PromiseGate } from "./session-race-test-helpers.ts";

type ExecuteTool = Parameters<typeof runAgentLoop>[0]["executeTool"];
type RecordMessage = Parameters<typeof runAgentLoop>[0]["recordMessage"];

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
    recordMessage: (messages, usage) => {
      recorded.push(...messages);
      if (usage?.contextTokens !== null && usage?.contextTokens !== undefined) {
        recordedContextTokens.push(usage.contextTokens);
      }
    },
  });
  expect(recordedContextTokens.at(-1)).toBe(expectedContextTokens);
  return recorded;
}

function emptyToolCall(
  id: string,
  name: string,
): AgentModelStep["toolCalls"][number] {
  return { arguments: "{}", id, name };
}

function completedStep(content: string): AgentModelStep {
  return providerStep(content);
}

function toolMessage(
  id: string,
  name: string,
  content = `${id} complete`,
): AgentRecordedMessage {
  return {
    content,
    role: "tool",
    toolCallId: id,
    toolName: name,
  };
}

function persistenceGate(
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
  wait: (messages: Parameters<RecordMessage>[0]) => boolean,
): RecordMessage {
  return recordingPersistence(gate, recorded, wait);
}

function toolPersistenceGate(
  id: string,
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
): RecordMessage {
  return persistenceGate(
    gate,
    recorded,
    (messages) =>
      messages.find(
        (message) => message.role === "tool" && message.toolCallId === id,
      ) !== undefined,
  );
}

function terminalPersistenceRecorder(
  gate: PromiseGate,
  recorded: AgentRecordedMessage[],
): RecordMessage {
  return terminalPersistence(gate, recorded);
}

function runHandoffLoop(
  model: AgentModel,
  handoffRequested: () => boolean,
  executeTool: ExecuteTool,
  recordMessage: RecordMessage = () => undefined,
) {
  return runAgentLoop({
    executeTool,
    handoffRequested,
    initialMessages: [{ content: "Work", role: "user" }],
    model,
    recordMessage,
  });
}

function indexedCalls(count: number, recipientName: string) {
  return createParallelToolUses(count, () => recipientName);
}

function mixedIndexedCalls(count: number) {
  return createParallelToolUses(count, (index) =>
    index % 2 === 0 ? "read" : "brave_search",
  );
}

function invalidParallelCalls(parameters: unknown, recipientName: string) {
  return [
    { marker: "invalid", parameters, recipient_name: recipientName },
    { marker: "control", parameters: {}, recipient_name: "read" },
  ];
}

type BraveSearchExecute = NonNullable<
  Parameters<typeof testSkills>[0]["braveSearch"]
>;

function braveSearchSkill(execute: BraveSearchExecute) {
  return {
    execute: (_userId: string, arguments_: Readonly<Record<string, unknown>>) =>
      execute(arguments_),
  };
}

function testSkills(options: {
  readonly braveSearch?: (
    arguments_: Readonly<Record<string, unknown>>,
  ) => Promise<string>;
  readonly executeTool?: (
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly tools?: Parameters<typeof createAgentSkills>[0]["tools"];
}) {
  return createAgentSkills({
    braveSearch: braveSearchSkill(
      (arguments_) =>
        options.braveSearch?.(arguments_) ?? Promise.resolve("unused"),
    ),
    executeTool:
      options.executeTool ?? (() => Promise.resolve("unused runner output")),
    tools: options.tools ?? ["read", "parallel"],
    userId: "user-id",
  });
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

  test("persists every tool result before handing off at a safe boundary", async () => {
    const toolCalls = [
      emptyToolCall("call-1", "read"),
      emptyToolCall("call-2", "bash"),
    ];
    const model = new ScriptedAgentModel([
      { content: "Running tools.", toolCalls },
      { content: "This step must wait for recovery.", toolCalls: [] },
    ]);
    const firstToolPersistence = promiseGate();
    const recorded: AgentRecordedMessage[] = [];
    const handoff = deferredHandoff();
    const persistFirstTool = toolPersistenceGate(
      "call-1",
      firstToolPersistence,
      recorded,
    );

    const loop = runHandoffLoop(
      model,
      handoff.isRequested,
      (call) => Promise.resolve(`${call.id} complete`),
      persistFirstTool,
    );

    await firstToolPersistence.entered;
    expect(recorded.map(({ role }) => role)).toEqual(["assistant"]);
    handoff.request();
    firstToolPersistence.release(undefined);

    const result = await loop;

    expect(result.status).toBe("handoff");
    expect(model.requests).toHaveLength(1);
    expect(recorded).toEqual([
      { content: "Running tools.", role: "assistant", toolCalls },
      toolMessage("call-1", "read"),
      toolMessage("call-2", "bash"),
    ]);
  });

  test("completes when restart becomes pending during final persistence", async () => {
    const persistence = promiseGate();
    const terminalModel = completedStep("Durable response.");
    const model = new ScriptedAgentModel([terminalModel]);
    const persistedMessages: AgentRecordedMessage[] = [];
    const handoff = deferredHandoff();
    const loop = runHandoffLoop(
      model,
      handoff.isRequested,
      () => Promise.reject(new Error("No tool expected")),
      terminalPersistenceRecorder(persistence, persistedMessages),
    );

    expect(persistedMessages).toEqual([]);
    await requestHandoff(persistence, handoff.request);

    await expect(loop).resolves.toMatchObject({
      messages: [
        { content: "Work", role: "user" },
        { content: "Durable response.", role: "assistant", toolCalls: [] },
      ],
      status: "complete",
    });
    expect(persistedMessages).toEqual([
      { content: "Durable response.", role: "assistant", toolCalls: [] },
    ]);
    expect(model.requests).toHaveLength(1);
  });

  test("an abort outranks a simultaneously requested handoff", async () => {
    const model: AgentModel = {
      complete: () => Promise.reject(new Error("Model request was unexpected")),
    };
    await expectAborted(
      runAgentLoop({
        executeTool: () => Promise.resolve("Tool request was unexpected"),
        handoffRequested: () => true,
        initialMessages: [],
        model,
        recordMessage: () => undefined,
        signal: abortedSignal(),
      }),
    );
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

  test("continues until the model finishes without a step limit", async () => {
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
      braveSearch: braveSearchSkill((arguments_) => {
        searchCalls.push(arguments_);
        return Promise.resolve('{"results":[]}');
      }),
      executeTool: (name) => {
        runnerCalls.push(name);
        return Promise.resolve("runner result");
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
    const skills = testSkills({
      braveSearch: (arguments_) => {
        searchCalls.push(arguments_);
        return new Promise<string>((resolve) => {
          releaseSearch = () => {
            completions.push("brave_search");
            resolve(JSON.stringify(arguments_));
          };
        });
      },
      executeTool: (name, arguments_) => {
        runnerCalls.push(name);
        return new Promise<string>((resolve) => {
          releaseTool = () => {
            completions.push(name);
            resolve(JSON.stringify(arguments_));
          };
        });
      },
      tools: ["read", "parallel", "brave_search"],
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
    expect(JSON.parse((await output) ?? "null")).toEqual([
      {
        output: '{"query":"Bun"}',
        recipient_name: "brave_search",
      },
      {
        output: '{"path":"README.md"}',
        recipient_name: "read",
      },
    ]);
  });

  test("accepts more than eight mixed calls with bounded concurrency and input ordering", async () => {
    let active = 0;
    let maximumActive = 0;
    const started: number[] = [];
    const trackCall = async (
      arguments_: Readonly<Record<string, unknown>>,
    ): Promise<number> => {
      const index = Number(arguments_["index"]);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.push(index);
      await Bun.sleep(index % 3);
      active -= 1;
      return index;
    };
    const skills = testSkills({
      braveSearch: async (arguments_) => {
        const index = await trackCall(arguments_);
        return `skill-${String(index)}`;
      },
      executeTool: async (name, arguments_) => {
        const index = await trackCall(arguments_);
        if (index === 11) {
          throw new Error("tool failed");
        }
        return `${name}-${String(index)}`;
      },
      tools: ["read", "parallel", "brave_search", "list_sessions"],
    });
    const calls = indexedCalls(24, "read").map((call, index) => ({
      ...call,
      recipient_name:
        index % 3 === 0
          ? "brave_search"
          : index % 3 === 1
            ? call.recipient_name
            : "list_sessions",
    }));
    const output = await skills.execute("parallel", { tool_uses: calls });
    const results: unknown = JSON.parse(output ?? "null");

    expect(started).toHaveLength(24);
    expect(maximumActive).toBeGreaterThan(1);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(24);
    expect(Array.isArray(results) ? results[0] : undefined).toEqual({
      output: "skill-0",
      recipient_name: "brave_search",
    });
    expect(Array.isArray(results) ? results[1] : undefined).toEqual({
      output: "read-1",
      recipient_name: "read",
    });
    expect(Array.isArray(results) ? results[2] : undefined).toEqual({
      output: "list_sessions-2",
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[11] : undefined).toEqual({
      error: "tool failed",
      recipient_name: "list_sessions",
    });
    expect(Array.isArray(results) ? results[23] : undefined).toEqual({
      output: "list_sessions-23",
      recipient_name: "list_sessions",
    });
  });

  test("keeps complete parallel skill output for the shared final bound", async () => {
    const skills = testSkills({
      braveSearch: () => Promise.resolve("x".repeat(60 * 1_024)),
      executeTool: () => Promise.resolve("x".repeat(60 * 1_024)),
      tools: ["read", "parallel", "brave_search"],
    });
    const output = await skills.execute("parallel", {
      tool_uses: mixedIndexedCalls(20),
    });

    const largePayload = "x".repeat(60 * 1_024);
    expectCompleteParallelPayload(output ?? "", largePayload);
    const results: unknown = JSON.parse(output ?? "null");
    expect(Array.isArray(results) ? results.at(-1) : undefined).toMatchObject({
      recipient_name: "brave_search",
    });
  });

  test("propagates cancellation and stops scheduling parallel calls", async () => {
    const controller = new AbortController();
    let scheduled = 0;
    const skills = testSkills({
      executeTool: async (_name, _arguments, signal) => {
        scheduled += 1;
        if (scheduled === 4) {
          controller.abort();
        }
        await Bun.sleep(1);
        if (signal?.aborted === true) {
          throw new DOMException("stopped", "AbortError");
        }
        return "unexpected";
      },
    });
    const rejection = await captureRejection(
      skills.execute(
        "parallel",
        {
          tool_uses: indexedCalls(20, "read"),
        },
        controller.signal,
      ) ?? Promise.resolve("missing"),
    );

    expect(rejection).toBeInstanceOf(DOMException);
    expect(scheduled).not.toBe(20);
  });

  test("rejects malformed, single-call, and recursively nested parallel input", () => {
    const skills = testSkills({});

    expect(
      skills.execute("parallel", {
        tool_uses: [{ parameters: {}, recipient_name: "read" }],
      }),
    ).toBeUndefined();
    for (const toolUses of [
      invalidParallelCalls({}, "parallel"),
      invalidParallelCalls([], "read"),
    ]) {
      expect(
        skills.execute("parallel", { tool_uses: toolUses }),
      ).toBeUndefined();
    }
  });

  test("rejects disabled recipients inside parallel calls", async () => {
    let searchCalled = false;
    let runnerCall: string | undefined;
    const skills = testSkills({
      braveSearch: () => {
        searchCalled = true;
        return Promise.resolve("unexpected search result");
      },
      executeTool: (name) => {
        runnerCall = name;
        return Promise.resolve("enabled runner result");
      },
    });

    const output = await skills.execute("parallel", {
      tool_uses: [
        { parameters: { path: "README.md" }, recipient_name: "read" },
        { parameters: { query: "disabled" }, recipient_name: "brave_search" },
      ],
    });

    expect(searchCalled).toBe(false);
    expect(runnerCall).toBe("read");
    expect(JSON.parse(output ?? "null")).toEqual([
      { output: "enabled runner result", recipient_name: "read" },
      {
        output: "Error: brave_search is not enabled for this session.",
        recipient_name: "brave_search",
      },
    ]);
  });
});
