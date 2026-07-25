import {
  runAgentLoop,
  throwIfAgentAborted,
  type AgentConversationMessage,
  type AgentMessageRecorder,
  type AgentModel,
  type AgentModelTurn,
} from "../shared/agent-loop.ts";
import {
  shouldCompactContext,
  type AgentConversationCompactor,
} from "./agent-compaction.ts";
import {
  agentTurnUsage,
  compactionUsage,
  type CompactionUsage,
} from "./session-compaction-usage.ts";

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
  readonly recordCompaction: (
    summary: string,
    usage: CompactionUsage,
  ) => Promise<void> | void;
  readonly recordMessage: AgentMessageRecorder;
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
  latestTurn: AgentModelTurn | undefined;
  pending: boolean;
  progressSinceCompaction: boolean;
  turnExceedsThreshold: boolean;
}

async function compactConversation(
  options: Pick<
    CompactingAgentLoopOptions,
    "agentCost" | "createCompactor" | "recordCompaction"
  >,
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
): Promise<readonly AgentConversationMessage[]> {
  const compacted = await options.createCompactor().compact(messages, signal);
  throwIfAgentAborted(signal);
  const usage = compactionUsage(compacted, options.agentCost);
  await options.recordCompaction(compacted.summary, usage);
  throwIfAgentAborted(signal);
  return compacted.messages;
}

export async function runCompactingAgentLoop(
  options: CompactingAgentLoopOptions,
): Promise<void> {
  let messages: readonly AgentConversationMessage[] = options.initialMessages;
  let allowCompaction = true;

  for (;;) {
    const compaction: CompactionState = {
      latestTurn: undefined,
      pending: false,
      progressSinceCompaction: false,
      turnExceedsThreshold: false,
    };

    const finalMessages = await runAgentLoop({
      executeTool: options.executeTool,
      initialMessages: messages,
      model: {
        complete: async (conversation, signal) => {
          const turn = await options.model.complete(conversation, signal);
          compaction.latestTurn = turn;
          compaction.turnExceedsThreshold = shouldCompactFinalTurn(
            options,
            turn.contextTokens,
          );
          compaction.pending =
            (allowCompaction || compaction.progressSinceCompaction) &&
            compaction.turnExceedsThreshold;
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
        compaction.progressSinceCompaction = false;
        compaction.turnExceedsThreshold = false;
        allowCompaction = false;
        return compactedMessages;
      },
      recordMessage: async (recordedMessages) => {
        const turn = compaction.latestTurn;
        const assistant = recordedMessages.some(
          (message) => message.role === "assistant",
        );
        const usage =
          assistant && turn !== undefined
            ? agentTurnUsage(turn, options.agentCost)
            : undefined;
        await options.recordMessage(recordedMessages, usage);
        if (assistant) {
          compaction.latestTurn = undefined;
        }
        if (recordedMessages.some((message) => message.role === "tool")) {
          compaction.progressSinceCompaction = true;
          if (compaction.turnExceedsThreshold) {
            compaction.pending = true;
          }
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
