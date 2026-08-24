import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
  AgentStepTruncation,
} from "../shared/agent-loop.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";

const AUTO_COMPACTION_THRESHOLD = 0.95;
export const AGENT_COMPACTION_REQUEST_MESSAGE = `Compact the conversation above into a concise handoff summary now. Preserve the user's goals, important decisions, constraints, relevant file paths, changes already made, command and test results, unresolved errors, and concrete next steps. If a complete final answer or deliverable is drafted but not yet delivered, include it (verbatim when it fits a concise summary, otherwise tightly condensed) and mark it as the finished answer. Do not call tools. Return only the summary.`;

// Shared with the persisted handoff in session-compaction.ts so every
// replay path - auto-compaction, manual, idle, compact-and-continue, and
// restart recovery - carries the delivery instruction (issue #204).
export const COMPACTION_HANDOFF_INSTRUCTION = `Treat the summary below as prior context and continue from it. If it contains a finished answer or deliverable that was never delivered, deliver it now instead of repeating research or verification:`;

const COMPACTION_PREFIX = `The earlier conversation was compacted. ${COMPACTION_HANDOFF_INSTRUCTION}\n\n`;

export interface AgentConversationCompactor {
  compact(...parameters: CompactionArguments): Promise<CompactedConversation>;
}

type CompactionArguments = readonly [
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
];

interface CompactedConversation {
  readonly contextTokens: AgentModelStep["contextTokens"];
  readonly costUsd: number | null;
  readonly messages: readonly AgentConversationMessage[];
  readonly summary: string;
  readonly tokenUsage: AgentModelStep["tokenUsage"];
}

interface InvalidCompactionUsage {
  readonly contextTokens: null;
  readonly costBasis: null;
  readonly costUsd: null;
  readonly tokenUsage: null;
}

function invalidCompactionSummaryError(): Error & {
  readonly usage: InvalidCompactionUsage;
} {
  const usage: InvalidCompactionUsage = {
    contextTokens: null,
    costBasis: null,
    costUsd: null,
    tokenUsage: null,
  };
  return Object.assign(
    new Error("The model returned an invalid compaction summary"),
    {
      name: "InvalidCompactionSummaryError",
      usage,
    },
  );
}

function toolCallsAreComplete(
  messages: readonly AgentConversationMessage[],
): boolean {
  const pending = new Set<string>();

  forEachAssistantToolCall(messages, (call) => {
    pending.add(call.id);
  });
  for (const message of messages) {
    if (message.role === "tool") {
      pending.delete(message.toolCallId);
    }
  }

  return pending.size === 0;
}

function compactionMessages(
  messages: readonly AgentConversationMessage[],
): readonly AgentConversationMessage[] {
  if (!toolCallsAreComplete(messages)) {
    throw new Error("The conversation cannot be compacted with pending tools");
  }

  return [
    ...messages,
    { content: AGENT_COMPACTION_REQUEST_MESSAGE, role: "user" as const },
  ];
}

export function shouldCompactContext(
  currentContextTokens: number,
  maxContextTokens: number | null,
): boolean {
  return (
    maxContextTokens !== null &&
    currentContextTokens / maxContextTokens >= AUTO_COMPACTION_THRESHOLD
  );
}

const COMPACTION_TRUNCATION_INSTRUCTION: Readonly<
  Record<AgentStepTruncation, string>
> = {
  max_tokens:
    "The preceding assistant response reached the maximum output tokens and is partial. Preserve that fact explicitly in the summary; do not describe the response as a finished answer or deliverable.",
  model_context_window_exceeded:
    "The preceding assistant response is partial because the conversation filled the model context window. Preserve that fact explicitly in the summary; do not describe the response as a finished answer or deliverable.",
};

function compactionProviderMessage(
  message: AgentConversationMessage,
): AgentConversationMessage {
  return message.role === "compaction_notice"
    ? {
        content: COMPACTION_TRUNCATION_INSTRUCTION[message.truncation],
        role: "user",
      }
    : message;
}

export function createModelConversationCompactor(
  model: AgentModel,
  onRequest?: (content: string) => void,
): AgentConversationCompactor {
  return {
    compact: async (...parameters: CompactionArguments) => {
      const [messages, signal] = parameters;
      const input = compactionMessages(messages);
      const providerInput = input.map(compactionProviderMessage);
      onRequest?.(AGENT_COMPACTION_REQUEST_MESSAGE);
      let step: AgentModelStep;
      try {
        model.startStep?.();
        step = await model.complete(providerInput, signal);
      } finally {
        model.close?.();
      }
      if (
        step.toolCalls.length > 0 ||
        step.content.trim().length === 0 ||
        step.truncation !== undefined
      ) {
        throw invalidCompactionSummaryError();
      }
      const summary = step.content.trim();
      return {
        contextTokens: step.contextTokens,
        costUsd: step.costUsd,
        messages: [{ content: `${COMPACTION_PREFIX}${summary}`, role: "user" }],
        summary,
        tokenUsage: step.tokenUsage,
      };
    },
  };
}
