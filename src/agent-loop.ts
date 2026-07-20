import { isRecord } from "./auth-model.ts";

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

export interface AgentModelTurn {
  readonly content: string;
  readonly thinking: string;
  readonly toolCalls: readonly AgentToolCall[];
}

export interface AgentModel {
  readonly complete: (
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentModelTurn>;
}

type ParsedAgentToolCall = AgentToolRequest<Readonly<Record<string, unknown>>>;

interface AgentLoopOptions {
  readonly executeTool: (call: ParsedAgentToolCall) => Promise<string>;
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly model: AgentModel;
  readonly recordMessage: (
    message: AgentRecordedMessage,
  ) => Promise<void> | void;
  readonly signal?: AbortSignal;
}

const INVALID_ARGUMENTS_MESSAGE =
  "Error: the tool arguments were not a JSON object.";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("The agent session was stopped", "AbortError");
  }
}

function parseArguments(
  value: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const messages = [...options.initialMessages];

  for (;;) {
    throwIfAborted(options.signal);
    const turn = await options.model.complete(messages, options.signal);
    throwIfAborted(options.signal);
    if (turn.thinking.length > 0) {
      await options.recordMessage({
        content: turn.thinking,
        role: "thinking",
      });
    }

    const assistantMessage: AgentConversationMessage = {
      content: turn.content,
      role: "assistant",
      toolCalls: turn.toolCalls,
    };
    await options.recordMessage(assistantMessage);
    messages.push(assistantMessage);

    if (turn.toolCalls.length === 0) {
      return;
    }

    for (const call of turn.toolCalls) {
      throwIfAborted(options.signal);
      const arguments_ = parseArguments(call.arguments);
      const output =
        arguments_ === undefined
          ? INVALID_ARGUMENTS_MESSAGE
          : await options.executeTool({
              arguments: arguments_,
              id: call.id,
              name: call.name,
            });
      throwIfAborted(options.signal);
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
