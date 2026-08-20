import type { AgentToolCall } from "../shared/agent-loop.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";

export const READ_SESSION_CATEGORIES = [
  "system",
  "user",
  "assistant",
  "thinking",
  "tool",
  "error",
  "tools",
] as const;
export type ReadSessionCategory = (typeof READ_SESSION_CATEGORIES)[number];

export const DEFAULT_READ_SESSION_CATEGORIES: readonly ReadSessionCategory[] = [
  "user",
  "assistant",
];
export const DEFAULT_READ_SESSION_LIMIT = 20;
export const MAXIMUM_READ_SESSION_LIMIT = 100;

export interface ReadSessionToolInput {
  readonly categories: readonly ReadSessionCategory[];
  readonly limit: number;
  readonly sessionId: string;
}

interface ReadSessionRecord {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly role: "assistant" | "error" | "thinking" | "tool" | "user";
  readonly toolCallId?: string;
  readonly toolCalls?: readonly AgentToolCall[];
  readonly toolName?: string;
}

interface ReadSessionToolDefinition {
  readonly description: string;
  readonly name: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

interface ReadSessionIdentity {
  readonly id: string;
  readonly status: string;
  readonly title: string;
}

type ReadSessionMessage = AgentSessionMessage & {
  readonly role: "assistant" | "error" | "thinking" | "tool" | "user";
};

function isReadSessionMessage(
  message: AgentSessionMessage,
): message is ReadSessionMessage {
  return (
    message.role === "assistant" ||
    message.role === "error" ||
    message.role === "thinking" ||
    message.role === "tool" ||
    message.role === "user"
  );
}

function messageRecord(message: ReadSessionMessage): ReadSessionRecord {
  const common = {
    content: message.content,
    createdAt: message.createdAt,
    id: message.id,
    role: message.role,
  };
  if (message.role === "assistant") {
    return { ...common, toolCalls: message.toolCalls };
  }
  if (message.role === "tool") {
    return {
      ...common,
      ...(message.toolCallId === null
        ? {}
        : { toolCallId: message.toolCallId }),
      ...(message.toolName === null ? {} : { toolName: message.toolName }),
    };
  }
  return common;
}

export function readSessionOutput(options: {
  readonly input: ReadSessionToolInput;
  readonly matchedRecords?: number;
  readonly messages: readonly AgentSessionMessage[];
  readonly session: ReadSessionIdentity;
  readonly systemPrompt: string;
  readonly toolDefinitions: readonly ReadSessionToolDefinition[];
}): string {
  const selected = new Set(options.input.categories);
  const matches = options.messages
    .filter(
      (message): message is ReadSessionMessage =>
        isReadSessionMessage(message) && selected.has(message.role),
    )
    .map(messageRecord);
  const records = matches.slice(-options.input.limit);
  const matchedRecords = options.matchedRecords ?? matches.length;
  const truncatedByLimit = matchedRecords > options.input.limit;
  const definitions = selected.has("tools") ? options.toolDefinitions : [];
  return JSON.stringify(
    {
      content: {
        records,
        ...(selected.has("system")
          ? { systemPrompt: options.systemPrompt }
          : {}),
        ...(selected.has("tools") ? { toolDefinitions: definitions } : {}),
      },
      metadata: {
        matchedRecords,
        requestedLimit: options.input.limit,
        returnedRecords: records.length,
        selectedCategories: options.input.categories,
        toolDefinitions: {
          matched: definitions.length,
          returned: definitions.length,
        },
        truncated: truncatedByLimit,
        truncation: { limit: truncatedByLimit },
      },
      session: options.session,
    },
    null,
    2,
  );
}
