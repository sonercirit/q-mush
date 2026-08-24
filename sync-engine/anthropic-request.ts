import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AgentToolDefinition } from "../shared/agent-tools.ts";
import {
  anthropicReplayBlocksForRequest,
  anthropicReplayMatchesAssistant,
  type AnthropicAssistantReplay,
  type AnthropicReplayBlock,
} from "../shared/anthropic-replay.ts";
import { parseOptionalJsonRecord } from "../shared/json-record.ts";
import {
  anthropicReplayIdentityFrom,
  anthropicReplayMatchesIdentity,
  type AnthropicReplayIdentity,
} from "./anthropic-replay-identity.ts";
import {
  textInputItems,
  userAttachments,
} from "./provider-attachment-input.ts";
import {
  promptCacheBreakpoints,
  withAnthropicReplayCacheControl,
  withPromptCacheControl,
} from "./provider-prompt-cache.ts";
import type { ProviderModelRequest } from "./provider-request.ts";

export const ANTHROPIC_VERSION = "2023-06-01";
// Documented opt-in: pre-4.5 models degrade an input+max_tokens overshoot
// to stop_reason "model_context_window_exceeded" instead of rejecting the
// request; 4.5+ models already behave this way without the header.
export const ANTHROPIC_CONTEXT_WINDOW_BETA =
  "model-context-window-exceeded-2025-08-26";

export type AnthropicRequestOptions = Pick<
  ProviderModelRequest,
  | "adaptiveThinking"
  | "credential"
  | "credentialFingerprint"
  | "maxOutputTokens"
  | "messages"
  | "model"
  | "provider"
  | "reasoningEffort"
  | "resolvedModel"
  | "stream"
  | "systemPrompt"
  | "tools"
>;

interface AnthropicMessage {
  readonly content: readonly unknown[];
  readonly replayBlocks?: readonly AnthropicReplayBlock[];
  readonly role: "assistant" | "user";
}

const UNSAFE_TOOL_REPLAY =
  "The Anthropic assistant tool turn cannot be continued safely";

// Anthropic accepts images and PDF documents; other attachment modalities
// reach the model through the attachment fallback instead.
function attachmentBlocks(attachment: AgentAttachment): readonly unknown[] {
  const modality = agentAttachmentModality(attachment);

  if (modality !== "image" && modality !== "pdf") {
    return [];
  }

  const source = {
    data: attachment.data,
    media_type: attachment.mediaType,
    type: "base64",
  };
  return [
    modality === "image"
      ? { source, type: "image" }
      : { source, title: attachment.name, type: "document" },
  ];
}

function matchingReplay(
  message: Extract<AgentConversationMessage, { readonly role: "assistant" }>,
  identity: AnthropicReplayIdentity,
): AnthropicAssistantReplay | undefined {
  const replay = message.providerReplay;
  return replay !== undefined &&
    anthropicReplayMatchesIdentity(replay, identity) &&
    anthropicReplayMatchesAssistant(replay, message.content, message.toolCalls)
    ? replay
    : undefined;
}

function assistantBlocks(
  message: Extract<AgentConversationMessage, { readonly role: "assistant" }>,
  replayBlocks: readonly AnthropicReplayBlock[] | undefined,
): readonly unknown[] {
  if (replayBlocks !== undefined) {
    return replayBlocks;
  }
  return [
    ...textInputItems(message.content, "text"),
    ...message.toolCalls.map((call) => ({
      id: call.id,
      input: parseOptionalJsonRecord(call.arguments) ?? {},
      name: call.name,
      type: "tool_use" as const,
    })),
  ];
}

type ConversationMessageByRole = {
  readonly [Role in AgentConversationMessage["role"]]: Extract<
    AgentConversationMessage,
    { readonly role: Role }
  >;
};

type AnthropicMessageHandler<Role extends AgentConversationMessage["role"]> = (
  message: ConversationMessageByRole[Role],
  identity: AnthropicReplayIdentity,
) => AnthropicMessage | undefined;

const anthropicMessageHandlers: {
  readonly [
    Role in AgentConversationMessage["role"]
  ]: AnthropicMessageHandler<Role>;
} = {
  assistant: (message, identity) => {
    const replay = matchingReplay(message, identity);
    const replayBlocks =
      replay === undefined
        ? undefined
        : anthropicReplayBlocksForRequest(replay.blocks);
    const content = assistantBlocks(message, replayBlocks);
    return content.length === 0
      ? undefined
      : {
          content,
          ...(replayBlocks === undefined ? {} : { replayBlocks }),
          role: "assistant",
        };
  },
  compaction_notice: () => undefined,
  tool: (message) => ({
    content: [
      {
        content: message.content,
        tool_use_id: message.toolCallId,
        type: "tool_result",
      },
    ],
    role: "user",
  }),
  user: (message) => {
    const content = [
      ...textInputItems(message.content, "text"),
      ...userAttachments(message).flatMap(attachmentBlocks),
    ];
    return content.length === 0 ? undefined : { content, role: "user" };
  },
};

function anthropicMessage(
  message: AgentConversationMessage,
  identity: AnthropicReplayIdentity,
): AnthropicMessage | undefined {
  if (message.role === "assistant")
    return anthropicMessageHandlers.assistant(message, identity);
  if (message.role === "compaction_notice")
    return anthropicMessageHandlers.compaction_notice(message, identity);
  if (message.role === "tool")
    return anthropicMessageHandlers.tool(message, identity);
  return anthropicMessageHandlers.user(message, identity);
}

function continuationReplay(
  messages: readonly AgentConversationMessage[],
  assistantIndex: number,
  identity: AnthropicReplayIdentity,
): AnthropicAssistantReplay | undefined {
  const assistant = messages[assistantIndex];
  if (assistant?.role !== "assistant") return undefined;
  const results: Extract<
    AgentConversationMessage,
    { readonly role: "tool" }
  >[] = [];
  let index = assistantIndex + 1;
  for (;;) {
    const result = messages[index];
    if (result?.role !== "tool") break;
    results.push(result);
    index += 1;
  }
  if (results.length === 0) return undefined;
  const expectedIds = assistant.toolCalls.map(({ id }) => id);
  const resultIds = results.map(({ toolCallId }) => toolCallId);
  const expectedIdSet = new Set(expectedIds);
  const resultIdSet = new Set(resultIds);
  const replay = matchingReplay(assistant, identity);
  if (
    replay === undefined ||
    expectedIds.length === 0 ||
    expectedIdSet.size !== resultIdSet.size ||
    expectedIds.some((id) => !resultIdSet.has(id))
  ) {
    throw new Error(UNSAFE_TOOL_REPLAY);
  }
  return replay;
}

function trailingToolAssistantIndex(
  messages: readonly AgentConversationMessage[],
): number | undefined {
  if (messages.at(-1)?.role !== "tool") return undefined;
  let assistantIndex = messages.length - 1;
  while (messages[assistantIndex]?.role === "tool") {
    assistantIndex -= 1;
  }
  return messages[assistantIndex]?.role === "assistant"
    ? assistantIndex
    : undefined;
}

export function assertAnthropicContinuationReplays(
  messages: readonly AgentConversationMessage[],
  identity: AnthropicReplayIdentity,
): void {
  const assistantIndex = trailingToolAssistantIndex(messages);
  if (assistantIndex !== undefined) {
    continuationReplay(messages, assistantIndex, identity);
  }
}

// A trailing assistant replay is sent back verbatim to continue a paused
// turn, and merging joins every trailing assistant message into it, so no
// breakpoint may mark any block of that final merged message.
function preservedTrailingAssistantIndex(
  messages: readonly AnthropicMessage[],
): number {
  if (messages.at(-1)?.replayBlocks === undefined) {
    return messages.length;
  }
  let index = messages.length - 1;
  while (messages[index - 1]?.role === "assistant") {
    index -= 1;
  }
  return index;
}

function applyAnthropicMessageBreakpoint(
  messages: AnthropicMessage[],
  start: number,
  preservedFromIndex: number,
): void {
  let index = Math.min(start, preservedFromIndex - 1);
  while (index >= 0) {
    const currentIndex = index;
    const message = messages.at(currentIndex);
    index -= 1;
    if (message === undefined || message.content.length === 0) {
      continue;
    }
    const content =
      message.replayBlocks === undefined
        ? withPromptCacheControl(message.content)
        : withAnthropicReplayCacheControl(message.replayBlocks);
    if (content !== undefined) {
      messages[currentIndex] = { ...message, content };
      return;
    }
  }
}

function anthropicMessages(
  messages: readonly AgentConversationMessage[],
  identity: AnthropicReplayIdentity,
): readonly unknown[] {
  const breakpoints = promptCacheBreakpoints(messages);
  const converted: AnthropicMessage[] = [];
  const convertedAtOrBeforeSource: number[] = [];

  for (const [sourceIndex, message] of messages.entries()) {
    const result = anthropicMessage(message, identity);
    if (result !== undefined) {
      converted.push(result);
    }
    convertedAtOrBeforeSource[sourceIndex] = converted.length - 1;
  }

  const preservedFromIndex = preservedTrailingAssistantIndex(converted);
  for (const sourceIndex of breakpoints) {
    applyAnthropicMessageBreakpoint(
      converted,
      convertedAtOrBeforeSource[sourceIndex] ?? -1,
      preservedFromIndex,
    );
  }

  const merged: { content: unknown[]; role: "assistant" | "user" }[] = [];
  for (const message of converted) {
    const previous = merged.at(-1);

    if (previous?.role === message.role) {
      previous.content.push(...message.content);
      continue;
    }

    merged.push({ content: [...message.content], role: message.role });
  }

  return merged;
}

function continuationContainer(
  messages: readonly AgentConversationMessage[],
  identity: AnthropicReplayIdentity,
): string | undefined {
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    return matchingReplay(last, identity)?.container;
  }
  const assistantIndex = trailingToolAssistantIndex(messages);
  return assistantIndex === undefined
    ? undefined
    : continuationReplay(messages, assistantIndex, identity)?.container;
}

function anthropicTools(
  tools: readonly AgentToolDefinition[],
): readonly unknown[] {
  // Anthropic caches the prefix through a breakpoint on the final definition,
  // keeping the static tool catalog in the same one-hour prefix as the system
  // prompt.
  return withPromptCacheControl(
    tools.map(({ function: definition }) => ({
      description: definition.description,
      input_schema: definition.parameters,
      name: definition.name,
    })),
  );
}

export function anthropicRequestBody(
  options: AnthropicRequestOptions,
): unknown {
  // The Messages API documents max_tokens as required; the catalog's
  // per-model maximum output tokens supplies it when discovery reported one,
  // and permissive proxies accept the omission otherwise. The maximum is
  // deliberately not clamped to the remaining context: without a tokenizer
  // any input estimate is a guess, and an overshoot would truncate output
  // under our own `max_tokens` stop instead of the API's explicit
  // `model_context_window_exceeded` degradation — native on 4.5+ models and
  // opted into on earlier ones via ANTHROPIC_CONTEXT_WINDOW_BETA.
  // Thinking budgets stay on provider defaults. A selected reasoning effort
  // maps to the `output_config.effort` and turns on adaptive thinking with
  // visible summaries: adaptive-only models (Fable) ignore `enabled`, and
  // newer models default `display` to "omitted", which streams empty
  // thinking text while still billing thinking tokens. "none" sends neither
  // parameter, and "minimal" (an OpenAI level the Messages API rejects —
  // valid levels are low through max) maps to "low".
  const effort =
    options.reasoningEffort === "minimal" ? "low" : options.reasoningEffort;
  const reasoning =
    effort === undefined || effort === "none"
      ? {}
      : {
          output_config: { effort },
          ...(options.adaptiveThinking === false
            ? {}
            : { thinking: { display: "summarized", type: "adaptive" } }),
        };
  const identity = anthropicReplayIdentityFrom(options);
  assertAnthropicContinuationReplays(options.messages, identity);
  const container = continuationContainer(options.messages, identity);
  return {
    ...(options.maxOutputTokens === null
      ? {}
      : { max_tokens: options.maxOutputTokens }),
    messages: anthropicMessages(options.messages, identity),
    model: options.model,
    ...reasoning,
    ...(container === undefined ? {} : { container }),
    ...(options.stream ? { stream: true } : {}),
    system: withPromptCacheControl([
      { text: options.systemPrompt, type: "text" },
    ]),
    ...(options.tools.length === 0
      ? {}
      : { tools: anthropicTools(options.tools) }),
  };
}
