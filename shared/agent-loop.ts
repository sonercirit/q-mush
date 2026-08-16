import type { AgentAttachment } from "./agent-attachments.ts";
import type { AnthropicAssistantReplay } from "./anthropic-replay.ts";
import { isRecord } from "./auth-model.ts";
import { parseOptionalJsonRecord } from "./json-record.ts";
import type { AgentSessionUsageUpdate } from "./session-model.ts";
import type {
  RunnerCommandResult,
  ToolStreamTerminalState,
} from "./tool-stream.ts";

interface AgentToolRequest<Arguments> {
  readonly arguments: Arguments;
  readonly id: string;
  readonly name: string;
}

export type AgentToolCall = AgentToolRequest<string>;

export function normalizeAgentToolCall(
  call: AgentToolCall,
): AgentToolCall | undefined {
  const id = call.id.trim();
  const name = call.name.trim();
  if (id.length === 0 || name.length === 0) {
    return undefined;
  }
  return {
    arguments:
      parseOptionalJsonRecord(call.arguments) === undefined
        ? "{}"
        : call.arguments,
    id,
    name,
  };
}

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

export type AgentProviderReplay = AnthropicAssistantReplay;

export type AgentConversationMessage =
  | {
      readonly content: string;
      readonly attachments?: readonly AgentAttachment[];
      readonly images?: readonly AgentAttachment[];
      readonly role: "user";
    }
  | {
      readonly content: string;
      readonly providerReplay?: AgentProviderReplay;
      readonly role: "assistant";
      readonly toolCalls: readonly AgentToolCall[];
    }
  | {
      // Internal-only context for compaction. Provider completion sanitization
      // drops it so ordinary replay never gains the durable error row.
      readonly content: "";
      readonly role: "compaction_notice";
      readonly truncation: AgentStepTruncation;
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
      readonly role: "error" | "thinking";
    };

export interface AgentTokenUsage {
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

// Soft truncation stops: generation ended early but the response is valid.
// `max_tokens` hit the request's output cap; the context-window stop filled
// the model's window (native on Anthropic 4.5+, opted into earlier via the
// context-window beta).
export type AgentStepTruncation =
  "max_tokens" | "model_context_window_exceeded";

export interface AgentModelStep {
  readonly content: string;
  readonly contextTokens: number | null;
  readonly costUsd: number | null;
  readonly providerContinuation?: "anthropic_pause_turn";
  readonly providerReplay?: AgentProviderReplay;
  readonly thinking: string;
  readonly tokenUsage: AgentTokenUsage | null;
  readonly toolCalls: readonly AgentToolCall[];
  readonly truncation?: AgentStepTruncation;
}

function assistantConversationMessage(
  step: Pick<AgentModelStep, "content" | "providerReplay" | "toolCalls">,
): Extract<AgentConversationMessage, { readonly role: "assistant" }> {
  return {
    content: step.content,
    ...(step.providerReplay === undefined
      ? {}
      : { providerReplay: step.providerReplay }),
    role: "assistant",
    toolCalls: step.toolCalls,
  };
}

export interface AgentModel {
  // Releases pooled provider resources (such as a kept-alive WebSocket) when
  // the owning run finishes; safe to omit and to call repeatedly.
  readonly close?: () => void;
  readonly complete: (
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentModelStep>;
  readonly startStep?: () => void;
}

type ParsedAgentToolCall = AgentToolRequest<Readonly<Record<string, unknown>>>;

export type AgentMessageRecorder = (
  messages: readonly AgentRecordedMessage[],
  usage?: AgentSessionUsageUpdate,
) => Promise<void> | void;

export interface AgentLoopResult {
  readonly messages: readonly AgentConversationMessage[];
  readonly status: "complete" | "handoff";
}

export interface AgentLoopOptions {
  readonly executeTool: (
    call: ParsedAgentToolCall,
  ) => Promise<RunnerCommandResult | string>;
  readonly handoffRequested?: () => boolean;
  readonly initialMessages: readonly AgentConversationMessage[];
  readonly model: AgentModel;
  readonly onToolCall?: (call: AgentToolCall) => Promise<void> | void;
  readonly onToolResult?: (
    call: AgentToolCall,
    outcome: {
      readonly error?: unknown;
      readonly output?: string;
      readonly state?: ToolStreamTerminalState;
    },
  ) => Promise<void> | void;
  readonly prepareMessages?: (
    messages: readonly AgentConversationMessage[],
    signal?: AbortSignal,
  ) =>
    | Promise<readonly AgentConversationMessage[]>
    | readonly AgentConversationMessage[];
  readonly recordMessage: AgentMessageRecorder;
  readonly signal?: AbortSignal;
  readonly takeSteeringMessages?: () =>
    | Promise<
        readonly Extract<AgentConversationMessage, { readonly role: "user" }>[]
      >
    | readonly Extract<AgentConversationMessage, { readonly role: "user" }>[];
}

const INVALID_ARGUMENTS_MESSAGE =
  "Error: the tool arguments were not a JSON object.";

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

function handoffResult(
  messages: readonly AgentConversationMessage[],
): AgentLoopResult {
  return { messages, status: "handoff" };
}

function handoffIfRequested(
  options: AgentLoopOptions,
  messages: readonly AgentConversationMessage[],
): AgentLoopResult | undefined {
  throwIfAgentAborted(options.signal);
  return options.handoffRequested?.() === true
    ? handoffResult(messages)
    : undefined;
}

function normalizedToolResult(
  result: RunnerCommandResult | string,
): RunnerCommandResult {
  return typeof result === "string"
    ? { output: result, state: "completed" }
    : result;
}

async function takeSteeringMessages(
  options: AgentLoopOptions,
): Promise<readonly AgentConversationMessage[]> {
  const steering = await options.takeSteeringMessages?.();
  throwIfAgentAborted(options.signal);
  return steering ?? [];
}

function storeMessages(
  messages: AgentConversationMessage[],
  steering: readonly AgentConversationMessage[],
): boolean {
  if (steering.length === 0) {
    return false;
  }
  messages.push(...steering);
  return true;
}

const TRUNCATED_CALL_MESSAGE =
  "Error: the response was truncated, so this tool call may be incomplete and was not executed. Retry it, in smaller steps if needed.";

export const TRUNCATION_NOTICES: Readonly<Record<AgentStepTruncation, string>> =
  {
    max_tokens:
      "The response was truncated: it reached the maximum output tokens.",
    model_context_window_exceeded:
      "The response was truncated: the conversation filled the model's context window.",
  };

export function isTruncationNotice(
  content: string,
): content is (typeof TRUNCATION_NOTICES)[AgentStepTruncation] {
  return Object.values(TRUNCATION_NOTICES).some((notice) => notice === content);
}

export function truncationFromNotice(
  content: string,
): AgentStepTruncation | undefined {
  if (content === TRUNCATION_NOTICES.max_tokens) {
    return "max_tokens";
  }
  return content === TRUNCATION_NOTICES.model_context_window_exceeded
    ? "model_context_window_exceeded"
    : undefined;
}

async function takeAndStoreSteering(
  options: AgentLoopOptions,
  messages: AgentConversationMessage[],
): Promise<boolean> {
  return storeMessages(messages, await takeSteeringMessages(options));
}

function nextStepHasInput(
  messages: readonly AgentConversationMessage[],
): boolean {
  const last = messages.at(-1);
  return last !== undefined && last.role !== "assistant";
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  let messages = [...options.initialMessages];

  for (;;) {
    const initialHandoff = handoffIfRequested(options, messages);
    if (initialHandoff !== undefined) {
      return initialHandoff;
    }
    if (options.prepareMessages !== undefined) {
      messages = [...(await options.prepareMessages(messages, options.signal))];
      const preparedHandoff = handoffIfRequested(options, messages);
      if (preparedHandoff !== undefined) {
        return preparedHandoff;
      }
    }
    if (!nextStepHasInput(messages)) {
      return { messages, status: "complete" };
    }
    options.model.startStep?.();
    const step = await options.model.complete(messages, options.signal);
    throwIfAgentAborted(options.signal);
    const recordedMessages: AgentRecordedMessage[] = [];
    if (step.thinking.length > 0) {
      recordedMessages.push({
        content: step.thinking,
        role: "thinking",
      });
    }

    if (
      step.contextTokens !== null &&
      (step.contextTokens < 0 || !Number.isSafeInteger(step.contextTokens))
    ) {
      throw new Error("The model returned invalid context usage");
    }

    const assistantMessage = assistantConversationMessage(step);
    recordedMessages.push(assistantMessage);
    if (step.truncation !== undefined) {
      // Record the soft stop durably so a truncated answer is never mistaken
      // for a finished one; error rows stay out of provider replay.
      recordedMessages.push({
        content: TRUNCATION_NOTICES[step.truncation],
        role: "error",
      });
    }
    await options.recordMessage(recordedMessages, {
      contextTokens: step.contextTokens,
      costBasis: step.costUsd === null ? null : "reported",
      costUsd: step.costUsd,
    });
    throwIfAgentAborted(options.signal);
    messages.push(assistantMessage);

    if (step.toolCalls.length === 0) {
      if (await takeAndStoreSteering(options, messages)) {
        continue;
      }
      return { messages, status: "complete" };
    }

    for (const call of step.toolCalls) {
      throwIfAgentAborted(options.signal);
      await options.onToolCall?.(call);
      const arguments_ = parseArguments(call.arguments);
      let result: RunnerCommandResult;
      try {
        // A length stop can cut a call mid-argument, and a syntactically
        // valid prefix may silently omit later arguments: never execute
        // calls from a truncated step; fail them so the model retries.
        result =
          step.truncation !== undefined
            ? { output: TRUNCATED_CALL_MESSAGE, state: "failed" }
            : arguments_ === undefined
              ? { output: INVALID_ARGUMENTS_MESSAGE, state: "failed" }
              : normalizedToolResult(
                  await options.executeTool({
                    arguments: arguments_,
                    id: call.id,
                    name: call.name,
                  }),
                );
      } catch (error) {
        await options.onToolResult?.(call, { error });
        throw error;
      }
      throwIfAgentAborted(options.signal);
      const toolMessage: AgentConversationMessage = {
        content: result.output,
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
      };
      await options.recordMessage([toolMessage]);
      throwIfAgentAborted(options.signal);
      messages.push(toolMessage);
      await options.onToolResult?.(call, result);
    }

    await takeAndStoreSteering(options, messages);
  }
}
