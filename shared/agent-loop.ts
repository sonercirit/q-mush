import type { AgentImage } from "./agent-images.ts";
import { isRecord } from "./auth-model.ts";
import { parseOptionalJsonRecord } from "./json-record.ts";

interface AgentToolRequest<Arguments> {
  readonly arguments: Arguments;
  readonly id: string;
  readonly name: string;
}

export type AgentToolCall = AgentToolRequest<string>;

function readAgentToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const arguments_ = value["arguments"];
  const id = value["id"];
  const name = value["name"];
  return typeof arguments_ === "string" &&
    typeof id === "string" &&
    typeof name === "string"
    ? { arguments: arguments_, id, name }
    : undefined;
}

export function readAgentToolCalls(
  values: readonly unknown[],
  errorMessage: string,
): readonly AgentToolCall[] {
  return values.map((value) => {
    const call = readAgentToolCall(value);

    if (call === undefined) {
      throw new Error(errorMessage);
    }

    return call;
  });
}

export type AgentConversationMessage =
  | {
      readonly content: string;
      readonly images?: readonly AgentImage[];
      readonly role: "user";
    }
  | {
      readonly content: string;
      readonly role: "assistant";
      readonly toolCalls: readonly AgentToolCall[];
    }
  | {
      readonly content: string;
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
    };

export type AgentRecordedMessage =
  | Extract<AgentConversationMessage, { readonly role: "assistant" | "tool" }>
  | {
      readonly content: string;
      readonly role: "thinking";
    };

export interface AgentTokenUsage {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentModelTurn {
  readonly content: string;
  readonly contextTokens: number | null;
  readonly costUsd: number | null;
  readonly thinking: string;
  readonly tokenUsage: AgentTokenUsage | null;
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AgentModel {
  readonly complete: (
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentModelTurn>;
}

type ParsedAgentToolCall = AgentToolRequest<Readonly<Record<string, unknown>>>;

export interface AgentLoopOptions {
  readonly executeTool: (call: ParsedAgentToolCall) => Promise<string>;
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly model: AgentModel;
  readonly prepareMessages?: (
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) =>
    | Promise<readonly AgentConversationMessage[]>
    | readonly AgentConversationMessage[];
  readonly recordMessage: (
    message: AgentRecordedMessage,
  ) => Promise<void> | void;
  readonly recordUsage?: (input: {
    readonly contextTokens: number | null;
    readonly costBasis: "estimated" | "reported" | null;
    readonly costUsd: number | null;
  }) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

const INVALID_ARGUMENTS_MESSAGE =
  "Error: the tool arguments were not a JSON object.";

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function throwIfAgentAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
}

function parseArguments(
  value: string,
): Readonly<Record<string, unknown>> | undefined {
  return parseOptionalJsonRecord(value);
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<readonly AgentConversationMessage[]> {
  let messages = [...options.initialMessages];

  for (;;) {
    throwIfAgentAborted(options.signal);
    if (options.prepareMessages !== undefined) {
      messages = [...(await options.prepareMessages(messages, options.signal))];
      throwIfAgentAborted(options.signal);
    }
    const turn = await options.model.complete(messages, options.signal);
    throwIfAgentAborted(options.signal);
    if (turn.thinking.length > 0) {
      await options.recordMessage({
        content: turn.thinking,
        role: "thinking",
      });
    }

    if (
      turn.contextTokens !== null &&
      (turn.contextTokens < 0 || !Number.isSafeInteger(turn.contextTokens))
    ) {
      throw new Error("The model returned invalid context usage");
    }

    const assistantMessage: AgentConversationMessage = {
      content: turn.content,
      role: "assistant",
      toolCalls: turn.toolCalls,
    };
    await options.recordMessage(assistantMessage);
    if (turn.contextTokens !== null || turn.costUsd !== null) {
      await options.recordUsage?.({
        contextTokens: turn.contextTokens,
        costBasis: turn.costUsd === null ? null : "reported",
        costUsd: turn.costUsd,
      });
    }
    messages.push(assistantMessage);

    if (turn.toolCalls.length === 0) {
      return messages;
    }

    for (const call of turn.toolCalls) {
      throwIfAgentAborted(options.signal);
      const arguments_ = parseArguments(call.arguments);
      const output =
        arguments_ === undefined
          ? INVALID_ARGUMENTS_MESSAGE
          : await options.executeTool({
              arguments: arguments_,
              id: call.id,
              name: call.name,
            });
      throwIfAgentAborted(options.signal);
      const toolMessage: AgentConversationMessage = {
        content: output,
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
      };
      await options.recordMessage(toolMessage);
      messages.push(toolMessage);
    }
  }
}
