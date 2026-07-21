import {
  shouldCompactContext,
  type AgentConversationCompactor,
} from "./agent-compaction.ts";
import {
  runAgentLoop,
  type AgentConversationMessage,
  type AgentModel,
  type AgentRecordedMessage,
} from "./agent-loop.ts";

interface CompactingAgentLoopOptions {
  readonly autoCompact: boolean;
  readonly createCompactor: () => AgentConversationCompactor;
  readonly executeTool: Parameters<typeof runAgentLoop>[0]["executeTool"];
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly maxContextTokens: number | null;
  readonly model: AgentModel;
  readonly recordCompaction: (summary: string) => Promise<void> | void;
  readonly recordContextTokens: (tokens: number) => Promise<void> | void;
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

export async function runCompactingAgentLoop(
  options: CompactingAgentLoopOptions,
): Promise<void> {
  const compaction: CompactionState = { pending: false };

  const finalMessages = await runAgentLoop({
    executeTool: options.executeTool,
    initialMessages: options.initialMessages,
    model: {
      complete: async (conversation, signal) => {
        const turn = await options.model.complete(conversation, signal);
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

      const compacted = await options
        .createCompactor()
        .compact(messages, signal);
      await options.recordCompaction(compacted.summary);
      compaction.pending = false;
      return compacted.messages;
    },
    recordContextTokens: options.recordContextTokens,
    recordMessage: options.recordMessage,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (compaction.pending) {
    const compacted = await options
      .createCompactor()
      .compact(finalMessages, options.signal);
    await options.recordCompaction(compacted.summary);
  }
}
