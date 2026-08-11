import {
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import type { AgentToolDefinition } from "../shared/agent-tools.ts";
import { parseOptionalJsonRecord } from "../shared/json-record.ts";
import {
  textInputItems,
  userAttachments,
} from "./provider-attachment-input.ts";
import {
  promptCacheBreakpoints,
  withPromptCacheControl,
} from "./provider-prompt-cache.ts";
import type { ProviderModelRequest } from "./provider-request.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

export type AnthropicRequestOptions = Pick<
  ProviderModelRequest,
  "messages" | "model" | "reasoningEffort" | "stream" | "systemPrompt" | "tools"
>;

interface AnthropicMessage {
  readonly content: readonly unknown[];
  readonly role: "assistant" | "user";
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

function anthropicMessage(
  message: AgentConversationMessage,
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
      const content = [
        ...textInputItems(message.content, "text"),
        ...message.toolCalls.map((call) => ({
          id: call.id,
          input: parseOptionalJsonRecord(call.arguments) ?? {},
          name: call.name,
          type: "tool_use",
        })),
      ];
      return content.length === 0 ? undefined : { content, role: "assistant" };
    }
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

function anthropicMessages(
  messages: readonly AgentConversationMessage[],
): readonly unknown[] {
  const breakpoints = promptCacheBreakpoints(messages);
  const merged: { content: unknown[]; role: "assistant" | "user" }[] = [];

  for (const [index, message] of messages.entries()) {
    const converted = anthropicMessage(message);

    if (converted === undefined) {
      continue;
    }

    const content = breakpoints.has(index)
      ? withPromptCacheControl(converted.content)
      : converted.content;
    const previous = merged.at(-1);

    if (previous?.role === converted.role) {
      previous.content.push(...content);
      continue;
    }

    merged.push({ content: [...content], role: converted.role });
  }

  return merged;
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
  // The request sends no output or thinking budgets, deferring to provider
  // defaults. A selected reasoning effort maps to the Messages API's
  // `output_config.effort` and turns on adaptive thinking with visible
  // summaries: adaptive-only models (Fable) ignore `enabled`, and newer
  // models default `display` to "omitted", which streams empty thinking text
  // while still billing thinking tokens. "none" sends neither parameter.
  const reasoning =
    options.reasoningEffort === undefined || options.reasoningEffort === "none"
      ? {}
      : {
          output_config: { effort: options.reasoningEffort },
          thinking: { display: "summarized", type: "adaptive" },
        };
  return {
    messages: anthropicMessages(options.messages),
    model: options.model,
    ...reasoning,
    ...(options.stream ? { stream: true } : {}),
    system: withPromptCacheControl([
      { text: options.systemPrompt, type: "text" },
    ]),
    ...(options.tools.length === 0
      ? {}
      : { tools: anthropicTools(options.tools) }),
  };
}
