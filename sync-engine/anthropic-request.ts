import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AgentToolDefinition } from "../shared/agent-tools.ts";
import {
  anthropicReplayMatchesAssistant,
  type AnthropicAssistantReplay,
} from "../shared/anthropic-replay.ts";
import { parseOptionalJsonRecord } from "../shared/json-record.ts";
import {
  anthropicReplayIdentityFrom,
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
  | "stream"
  | "systemPrompt"
  | "tools"
>;

interface AnthropicMessage {
  readonly content: readonly unknown[];
  readonly replay?: AnthropicAssistantReplay;
  readonly role: "assistant" | "user";
}

interface ConvertedAnthropicMessage extends AnthropicMessage {
  readonly sourceIndex: number;
}

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
  return replay?.model === identity.model &&
    replay.provenance === identity.provenance &&
    anthropicReplayMatchesAssistant(replay, message.content, message.toolCalls)
    ? replay
    : undefined;
}

function assistantBlocks(
  message: Extract<AgentConversationMessage, { readonly role: "assistant" }>,
  replay: AnthropicAssistantReplay | undefined,
): readonly unknown[] {
  if (replay !== undefined) {
    return replay.blocks;
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

function anthropicMessage(
  message: AgentConversationMessage,
  identity: AnthropicReplayIdentity,
): AnthropicMessage | undefined {
  switch (message.role) {
    case "user": {
      const content = [
        ...textInputItems(message.content, "text"),
        ...userAttachments(message).flatMap(attachmentBlocks),
      ];
      return content.length === 0 ? undefined : { content, role: "user" };
    }
    case "assistant": {
      const replay = matchingReplay(message, identity);
      const content = assistantBlocks(message, replay);
      return content.length === 0
        ? undefined
        : {
            content,
            ...(replay === undefined ? {} : { replay }),
            role: "assistant",
          };
    }
    case "compaction_notice":
      return undefined;
    case "tool":
      return {
        content: [
          {
            content: message.content,
            tool_use_id: message.toolCallId,
            type: "tool_result",
          },
        ],
        role: "user",
      };
  }
}

function applyAnthropicMessageBreakpoint(
  messages: ConvertedAnthropicMessage[],
  start: number,
  preserveFinalReplay: boolean,
): void {
  let index = start;
  while (index >= 0) {
    const currentIndex = index;
    const message = messages.at(currentIndex);
    index -= 1;
    if (message === undefined) {
      continue;
    }
    if (message.replay === undefined) {
      if (message.content.length === 0) {
        continue;
      }
      messages[currentIndex] = {
        ...message,
        content: withPromptCacheControl(message.content),
      };
      return;
    }
    if (preserveFinalReplay && currentIndex === messages.length - 1) {
      continue;
    }
    const content = withAnthropicReplayCacheControl(message.replay.blocks);
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
  const converted: ConvertedAnthropicMessage[] = [];

  for (const [sourceIndex, message] of messages.entries()) {
    const result = anthropicMessage(message, identity);
    if (result !== undefined) {
      converted.push({ ...result, sourceIndex });
    }
  }

  const preserveFinalReplay =
    converted.at(-1)?.role === "assistant" &&
    converted.at(-1)?.replay !== undefined;
  for (const sourceIndex of breakpoints) {
    let index = converted.length - 1;
    while (
      index >= 0 &&
      (converted[index]?.sourceIndex ?? Number.NEGATIVE_INFINITY) > sourceIndex
    ) {
      index -= 1;
    }
    applyAnthropicMessageBreakpoint(converted, index, preserveFinalReplay);
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
  if (last?.role !== "assistant") return undefined;
  return matchingReplay(last, identity)?.container;
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
