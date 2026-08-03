import { expect } from "vitest";
import type {
  AgentMessageRecorder,
  AgentRecordedMessage,
} from "../../shared/agent-loop.ts";
import type {
  AgentConversationCompactor,
  CompactedConversation,
} from "../../sync-engine/agent-compaction.ts";
import { runCompactingAgentLoop } from "../../sync-engine/session-agent-loop.ts";
import { ScriptedAgentModel } from "./scripted-agent-model.ts";
import type { PromiseGate } from "./session-race-test-helpers.ts";

export const TOOL_CALL = {
  arguments: '{"path":"README.md"}',
  id: "call-1",
  name: "read",
};

export type LoopOptions = Parameters<typeof runCompactingAgentLoop>[0];

export function compacted(
  summary: string,
  costUsd: number | null = null,
): CompactedConversation {
  return {
    contextTokens: null,
    costUsd,
    messages: [{ content: summary, role: "user" }],
    summary,
    tokenUsage: null,
  };
}

export function countedCompactor(
  increment: () => void,
  summary?: string,
): () => AgentConversationCompactor {
  return () => ({
    compact: () => {
      increment();
      return Promise.resolve(compacted(summary ?? "Unexpected handoff"));
    },
  });
}

export function recordingCompactor(
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

export function highStep(content: string, contextTokens = 95_000) {
  return { content, contextTokens, toolCalls: [] };
}

export function toolMessage(
  id: string,
  content = `${id} complete`,
): Extract<LoopOptions["initialMessages"][number], { readonly role: "tool" }> {
  return {
    content,
    role: "tool",
    toolCallId: id,
    toolName: "read",
  };
}

export function recordingMessages(
  recorded: unknown[],
): LoopOptions["recordMessage"] {
  return (messages) => {
    recorded.push(...messages);
  };
}

export function recordingPersistence(
  gate: PromiseGate,
  recorded: unknown[],
  wait: (messages: readonly AgentRecordedMessage[]) => boolean,
): AgentMessageRecorder {
  return async (messages) => {
    if (wait(messages)) await gate.wait();
    recorded.push(...messages);
  };
}

export function terminalPersistence(
  gate: PromiseGate,
  recorded: unknown[],
): AgentMessageRecorder {
  return recordingPersistence(gate, recorded, () => true);
}

export async function requestHandoff(
  gate: PromiseGate,
  request: () => void,
): Promise<void> {
  await gate.entered;
  request();
  gate.release(undefined);
}

export function deferredHandoff() {
  let requested = false;
  return {
    isRequested: () => requested,
    request: () => {
      requested = true;
    },
  };
}

export function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function requestHandoffAndWait<T>(
  gate: PromiseGate,
  request: () => void,
  loop: Promise<T>,
): Promise<T> {
  await requestHandoff(gate, request);
  return loop;
}

export async function expectCompletedHandoff<T>(
  gate: PromiseGate,
  handoff: ReturnType<typeof deferredHandoff>,
  loop: Promise<T>,
): Promise<void> {
  await expect(
    requestHandoffAndWait(gate, handoff.request, loop),
  ).resolves.toBe("complete");
}

export function expectLoopCounts(
  compactorRequests: number,
  model: ScriptedAgentModel,
  expectedCompactions: number,
  expectedModelRequests: number,
): void {
  expect(compactorRequests).toBe(expectedCompactions);
  expect(model.requests).toHaveLength(expectedModelRequests);
}

export function recordingToolPersistence(
  gate: PromiseGate,
  recorded: unknown[],
): LoopOptions["recordMessage"] {
  return recordingPersistence(gate, recorded, (messages) =>
    messages.some(
      (message) => message.role === "tool" && message.toolCallId === "call-1",
    ),
  );
}

export function runTestLoop(
  options: Pick<LoopOptions, "createCompactor" | "model"> &
    Partial<Omit<LoopOptions, "createCompactor" | "model">>,
): Promise<"complete" | "handoff"> {
  return runCompactingAgentLoop({
    agentCost: () => null,
    autoCompact: true,
    executeTool: () => Promise.reject(new Error("No tool expected")),
    initialMessages: [{ content: "Finish", role: "user" }],
    maxContextTokens: 100_000,
    now: Date.now,
    recordCompaction: () => undefined,
    recordMessage: () => undefined,
    ...options,
  });
}

export function expectAborted(value: PromiseLike<unknown>): Promise<void> {
  return expect(value).rejects.toMatchObject({ name: "AbortError" });
}

export function triggeredModel() {
  return new ScriptedAgentModel([highStep("Trigger compaction.")]);
}

export async function expectCompactionFailure(options: {
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
