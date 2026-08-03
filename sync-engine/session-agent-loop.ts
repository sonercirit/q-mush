import {
  runAgentLoop,
  throwIfAgentAborted,
  type AgentConversationMessage,
  type AgentMessageRecorder,
  type AgentModel,
  type AgentModelStep,
} from "../shared/agent-loop.ts";
import {
  shouldCompactContext,
  type AgentConversationCompactor,
} from "./agent-compaction.ts";
import { restartHandoffResult } from "./session-agent-handoff.ts";
import {
  agentStepUsage,
  compactionUsage,
  type CompactionUsage,
} from "./session-compaction-usage.ts";

interface CompactingAgentLoopOptions {
  readonly agentCost: (
    step: Pick<AgentModelStep, "costUsd" | "tokenUsage">,
  ) => number | null;
  readonly autoCompact: boolean;
  readonly createCompactor: () => AgentConversationCompactor;
  readonly executeTool: Parameters<typeof runAgentLoop>[0]["executeTool"];
  readonly handoffRequested?: () => boolean;
  readonly initialContextTokens?: number;
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly maxContextTokens: number | null;
  readonly model: AgentModel;
  readonly now: () => number;
  readonly onToolCall?: Parameters<typeof runAgentLoop>[0]["onToolCall"];
  readonly onToolResult?: Parameters<typeof runAgentLoop>[0]["onToolResult"];
  readonly recordCompaction: (
    summary: string,
    usage: CompactionUsage,
    startedAt: number,
  ) => Promise<void> | void;
  readonly settleCompaction?: () => void;
  readonly recordMessage: (
    messages: Parameters<AgentMessageRecorder>[0],
    usage: Parameters<AgentMessageRecorder>[1],
    terminal: boolean,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly takeSteeringMessages?: Parameters<
    typeof runAgentLoop
  >[0]["takeSteeringMessages"];
}

function shouldCompactFinalStep(
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
  latestStep: AgentModelStep | undefined;
  pending: boolean;
  progressSinceCompaction: boolean;
  restartPendingOnCompletion: boolean;
  stepExceedsThreshold: boolean;
}

async function compactConversation(
  options: Pick<
    CompactingAgentLoopOptions,
    | "agentCost"
    | "createCompactor"
    | "now"
    | "recordCompaction"
    | "settleCompaction"
  >,
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
): Promise<readonly AgentConversationMessage[]> {
  const startedAt = options.now();
  try {
    const compacted = await options.createCompactor().compact(messages, signal);
    throwIfAgentAborted(signal);
    const usage = compactionUsage(compacted, options.agentCost);
    await options.recordCompaction(compacted.summary, usage, startedAt);
    throwIfAgentAborted(signal);
    return compacted.messages;
  } finally {
    options.settleCompaction?.();
  }
}

export async function runCompactingAgentLoop(
  options: CompactingAgentLoopOptions,
): Promise<"complete" | "handoff"> {
  let messages: readonly AgentConversationMessage[] = options.initialMessages;
  let allowCompaction = true;

  if (
    options.initialContextTokens !== undefined &&
    shouldCompactFinalStep(options, options.initialContextTokens)
  ) {
    const beforeCompaction = restartHandoffResult(
      options.signal,
      options.handoffRequested,
      "handoff",
    );
    if (beforeCompaction !== undefined) {
      return beforeCompaction;
    }
    const compacted = await compactConversation(
      options,
      messages,
      options.signal,
    );

    const afterCompaction = restartHandoffResult(
      options.signal,
      options.handoffRequested,
      "complete",
    );
    if (afterCompaction !== undefined) {
      return afterCompaction;
    }
    messages = compacted;
    allowCompaction = false;
  }

  for (;;) {
    const compaction: CompactionState = {
      latestStep: undefined,
      pending: false,
      progressSinceCompaction: false,
      restartPendingOnCompletion: false,
      stepExceedsThreshold: false,
    };
    const final = await runAgentLoop({
      executeTool: options.executeTool,
      ...(options.handoffRequested === undefined
        ? {}
        : { handoffRequested: options.handoffRequested }),
      initialMessages: messages,
      model: {
        complete: async (conversation, signal) => {
          const step = await options.model.complete(conversation, signal);
          compaction.latestStep = step;
          compaction.stepExceedsThreshold = shouldCompactFinalStep(
            options,
            step.contextTokens,
          );
          compaction.pending =
            (allowCompaction || compaction.progressSinceCompaction) &&
            compaction.stepExceedsThreshold;
          return step;
        },
        ...(options.model.startStep === undefined
          ? {}
          : { startStep: options.model.startStep }),
      },
      ...(options.onToolCall === undefined
        ? {}
        : { onToolCall: options.onToolCall }),
      ...(options.onToolResult === undefined
        ? {}
        : { onToolResult: options.onToolResult }),
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
        compaction.stepExceedsThreshold = false;
        allowCompaction = false;
        return compactedMessages;
      },
      recordMessage: async (recordedMessages) => {
        const step = compaction.latestStep;
        const terminal = step?.toolCalls.length === 0 && !compaction.pending;
        const assistant = recordedMessages.some(
          (message) => message.role === "assistant",
        );
        const usage =
          assistant && step !== undefined
            ? agentStepUsage(step, options.agentCost)
            : undefined;
        await options.recordMessage(recordedMessages, usage, terminal);
        throwIfAgentAborted(options.signal);
        if (assistant) {
          compaction.latestStep = undefined;
          if (
            step?.toolCalls.length === 0 &&
            options.handoffRequested?.() === true
          ) {
            compaction.restartPendingOnCompletion = true;
          }
        }
        if (recordedMessages.some((message) => message.role === "tool")) {
          compaction.progressSinceCompaction = true;
          if (compaction.stepExceedsThreshold) {
            compaction.pending = true;
          }
        }
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.takeSteeringMessages === undefined
        ? {}
        : { takeSteeringMessages: options.takeSteeringMessages }),
    });

    throwIfAgentAborted(options.signal);
    if (final.status === "handoff") {
      return "handoff";
    }
    if (compaction.pending) {
      messages = await compactConversation(
        options,
        final.messages,
        options.signal,
      );
      allowCompaction = false;
      throwIfAgentAborted(options.signal);
      if (
        compaction.restartPendingOnCompletion ||
        options.handoffRequested?.() === true
      ) {
        return "complete";
      }
      continue;
    }
    return final.status;
  }
}
