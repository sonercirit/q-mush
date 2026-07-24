import {
  runAgentLoop,
  type AgentConversationMessage,
  type AgentLoopOptions,
  type AgentModel,
  type AgentModelTurn,
  type AgentRecordedMessage,
} from "../shared/agent-loop.ts";
import {
  shouldCompactContext,
  type AgentConversationCompactor,
} from "./agent-compaction.ts";

interface CompactingAgentLoopOptions {
  readonly agentCost: (
    turn: Pick<AgentModelTurn, "costUsd" | "tokenUsage">,
  ) => number | null;
  readonly autoCompact: boolean;
  readonly createCompactor: () => AgentConversationCompactor;
  readonly executeTool: Parameters<typeof runAgentLoop>[0]["executeTool"];
  readonly handoffRequested?: () => boolean;
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly maxContextTokens: number | null;
  readonly model: AgentModel;
  readonly recordCompaction: (summary: string) => Promise<void> | void;
  readonly recordUsage: NonNullable<AgentLoopOptions["recordUsage"]>;
  readonly recordMessage: (
    message: AgentRecordedMessage,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

function shouldCompactFinalTurn(
  options: Pick<CompactingAgentLoopOptions, "autoCompact" | "maxContextTokens">,
  contextTokens: number | null,
): boolean {
  return (
    options.autoCompact &&
    contextTokens !== null &&
    shouldCompactContext(contextTokens, options.maxContextTokens)
  );
}

interface CompactionState {
  pending: boolean;
}

async function compactConversation(
  options: Pick<
    CompactingAgentLoopOptions,
    "agentCost" | "createCompactor" | "recordCompaction" | "recordUsage"
  >,
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
): Promise<readonly AgentConversationMessage[]> {
  const compacted = await options.createCompactor().compact(messages, signal);
  const costUsd =
    compacted.costUsd ??
    options.agentCost({
      costUsd: compacted.costUsd,
      tokenUsage: compacted.tokenUsage,
    });
  if (costUsd !== null) {
    await options.recordUsage({
      contextTokens: null,
      costBasis: compacted.costUsd === null ? "estimated" : "reported",
      costUsd,
    });
  }
  await options.recordCompaction(compacted.summary);
  return compacted.messages;
}

export async function runCompactingAgentLoop(
  options: CompactingAgentLoopOptions,
): Promise<"complete" | "handoff"> {
  const compaction: CompactionState = { pending: false };

  const final = await runAgentLoop({
    executeTool: options.executeTool,
    ...(options.handoffRequested === undefined
      ? {}
      : { handoffRequested: options.handoffRequested }),
    initialMessages: options.initialMessages,
    model: {
      complete: async (conversation, signal) => {
        const turn = await options.model.complete(conversation, signal);
        const costUsd = turn.costUsd ?? options.agentCost(turn);
        if (turn.contextTokens !== null || costUsd !== null) {
          const costBasis =
            costUsd === null
              ? null
              : turn.costUsd === null
                ? "estimated"
                : "reported";
          await options.recordUsage({
            contextTokens: turn.contextTokens,
            costBasis,
            costUsd,
          });
        }
        compaction.pending = shouldCompactFinalTurn(
          options,
          turn.contextTokens,
        );
        return turn;
      },
    },
    prepareMessages: async (messages, signal) => {
      if (!compaction.pending) {
        return messages;
      }

      const compactedMessages = await compactConversation(
        options,
        messages,
        signal,
      );
      compaction.pending = false;
      return compactedMessages;
    },
    recordMessage: options.recordMessage,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (compaction.pending && final.status === "complete") {
    await compactConversation(options, final.messages, options.signal);
  }
  return final.status;
}
