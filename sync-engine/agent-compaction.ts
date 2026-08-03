import type {
  AgentConversationMessage,
  AgentModel,
  AgentModelStep,
} from "../shared/agent-loop.ts";
import { forEachAssistantToolCall } from "./agent-conversation.ts";

const AUTO_COMPACTION_THRESHOLD = 0.95;
const AGENT_COMPACTION_REQUEST_MESSAGE = `Compact the conversation above into a concise handoff summary now. Preserve the user's goals, important decisions, constraints, relevant file paths, changes already made, command and test results, unresolved errors, and concrete next steps. Do not call tools. Return only the summary.`;

const COMPACTION_PREFIX = `The earlier conversation was compacted into this handoff summary. Treat it as prior context and continue from it:\n\n`;

export interface AgentConversationCompactor {
  compact(...parameters: CompactionArguments): Promise<CompactedConversation>;
}

type CompactionArguments = readonly [
  messages: readonly AgentConversationMessage[],
  signal?: AbortSignal,
];

export interface CompactedConversation {
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

class InvalidCompactionSummaryError extends Error {
  readonly usage: InvalidCompactionUsage;

  constructor() {
    super("The model returned an invalid compaction summary");
    this.name = "InvalidCompactionSummaryError";
    this.usage = {
      contextTokens: null,
      costBasis: null,
      costUsd: null,
      tokenUsage: null,
    };
  }
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

export class ModelConversationCompactor implements AgentConversationCompactor {
  readonly #model: AgentModel;
  readonly #onRequest: ((content: string) => void) | undefined;

  constructor(model: AgentModel, onRequest?: (content: string) => void) {
    this.#model = model;
    this.#onRequest = onRequest;
  }

  async compact(
    ...parameters: CompactionArguments
  ): Promise<CompactedConversation> {
    const [messages, signal] = parameters;
    const input = compactionMessages(messages);
    this.#onRequest?.(AGENT_COMPACTION_REQUEST_MESSAGE);
    const step: AgentModelStep = await this.#model.complete(input, signal);

    if (step.toolCalls.length > 0 || step.content.trim().length === 0) {
      throw new InvalidCompactionSummaryError();
    }

    const summary = step.content.trim();
    return {
      contextTokens: step.contextTokens,
      costUsd: step.costUsd,
      messages: [{ content: `${COMPACTION_PREFIX}${summary}`, role: "user" }],
      summary,
      tokenUsage: step.tokenUsage,
    };
  }
}
