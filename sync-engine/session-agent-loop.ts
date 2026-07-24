import {
  runAgentLoop,
  throwIfAgentAborted,
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
  progressSinceCompaction: boolean;
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
  throwIfAgentAborted(signal);
  const costUsd =
    compacted.costUsd ??
    options.agentCost({
      costUsd: compacted.costUsd,
      tokenUsage: compacted.tokenUsage,
    });
  await options.recordCompaction(compacted.summary);
  if (costUsd !== null) {
    await options.recordUsage({
      contextTokens: null,
      costBasis: compacted.costUsd === null ? "estimated" : "reported",
      costUsd,
    });
  }
  return compacted.messages;
}

export async function runCompactingAgentLoop(
  options: CompactingAgentLoopOptions,
): Promise<void> {
  let messages: readonly AgentConversationMessage[] = options.initialMessages;
  let allowCompaction = true;

  for (;;) {
    const compaction: CompactionState = {
      pending: false,
      progressSinceCompaction: false,
    };

    const finalMessages = await runAgentLoop({
      executeTool: options.executeTool,
      initialMessages: messages,
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
          compaction.pending =
            (allowCompaction || compaction.progressSinceCompaction) &&
            shouldCompactFinalTurn(options, turn.contextTokens);
          return turn;
        },
      },
      prepareMessages: async (preparedMessages, signal) => {
        if (!compaction.pending) {
          return preparedMessages;
        }

        const compactedMessages = await compactConversation(
          options,
          preparedMessages,
          signal,
        );
        compaction.pending = false;
        allowCompaction = false;
        return compactedMessages;
      },
      recordMessage: async (message) => {
        await options.recordMessage(message);
        if (message.role === "tool") {
          compaction.progressSinceCompaction = true;
        }
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    if (!compaction.pending) {
      return;
    }

    messages = await compactConversation(
      options,
      finalMessages,
      options.signal,
    );
    allowCompaction = false;
  }
}
