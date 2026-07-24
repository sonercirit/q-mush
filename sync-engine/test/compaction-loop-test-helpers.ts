import type {
  AgentConversationMessage,
  AgentModel,
} from "../../shared/agent-loop.ts";
import type { AgentConversationCompaction } from "../agent-compaction.ts";
import type { runCompactingAgentLoop } from "../session-agent-loop.ts";

export function emptyTestCompaction(
  compact: AgentConversationCompaction["compact"],
): AgentConversationCompaction {
  return {
    compact,
    complete: () => undefined,
    fail: () => undefined,
  };
}

export function testCompaction(
  compact: AgentConversationCompaction["compact"],
  phases: string[] = [],
): AgentConversationCompaction {
  return {
    compact,
    complete: () => {
      phases.push("complete");
    },
    fail: (_error, signal) => {
      phases.push(signal?.aborted === true ? "cancel" : "failure");
    },
  };
}

export function automaticCompactionOptions(options: {
  readonly createCompactor: () => AgentConversationCompaction;
  readonly executeTool?: () => Promise<string>;
  readonly model: AgentModel;
  readonly recordCompaction: () => void;
  readonly signal?: AbortSignal;
}): Parameters<typeof runCompactingAgentLoop>[0] {
  const signal = options.signal;
  if (signal === undefined) {
    return {
      agentCost: () => null,
      autoCompact: true,
      createCompactor: options.createCompactor,
      executeTool:
        options.executeTool ??
        (() => Promise.reject(new Error("No tool expected"))),
      initialMessages: TEST_COMPACTION_REQUEST,
      maxContextTokens: 100,
      model: options.model,
      recordCompaction: options.recordCompaction,
      recordMessage: () => undefined,
      recordUsage: () => undefined,
    };
  }
  const withoutSignal = {
    createCompactor: options.createCompactor,
    ...(options.executeTool === undefined
      ? {}
      : { executeTool: options.executeTool }),
    model: options.model,
    recordCompaction: options.recordCompaction,
  };
  return {
    ...automaticCompactionOptions(withoutSignal),
    signal,
  };
}

export const TEST_COMPACTION_REQUEST: readonly AgentConversationMessage[] = [
  { content: "Request", role: "user" },
];
