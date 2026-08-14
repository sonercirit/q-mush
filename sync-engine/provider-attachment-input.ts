import {
  agentAttachmentDataUrl,
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import { withPromptCacheControl } from "./provider-prompt-cache.ts";

export function textInputItems(
  content: string,
  type: "input_text" | "text",
): readonly unknown[] {
  return content.length === 0 ? [] : [{ text: content, type }];
}

export function userAttachments(
  message: Extract<AgentConversationMessage, { readonly role: "user" }>,
) {
  return message.attachments ?? message.images ?? [];
}

function providerAttachmentInput(
  attachment: AgentAttachment,
  responses: boolean,
): unknown {
  const url = agentAttachmentDataUrl(attachment);
  switch (agentAttachmentModality(attachment)) {
    case "image":
      return responses
        ? { image_url: url, type: "input_image" }
        : { image_url: { url }, type: "image_url" };
    case "video":
      return responses
        ? { video_url: url, type: "input_video" }
        : { type: "video_url", video_url: { url } };
    case "audio":
      return {
        input_audio: {
          data: attachment.data,
          format: attachment.mediaType.split("/")[1] ?? "audio",
        },
        type: "input_audio",
      };
    case "pdf":
    case "file":
      return responses
        ? {
            file_data: url,
            filename: attachment.name,
            type: "input_file",
          }
        : {
            file: { file_data: url, filename: attachment.name },
            type: "file",
          };
  }
}

// A cached message switches its text to content parts so an Anthropic-style
// cache_control marker can ride on the final part.
function chatContent(
  content: string | null,
  parts: readonly unknown[] | undefined,
  cached: boolean,
): unknown {
  if (!cached) {
    return parts ?? content;
  }

  const items =
    parts ??
    (typeof content === "string" ? textInputItems(content, "text") : []);
  return items.length === 0 ? content : withPromptCacheControl(items);
}

export function providerChatMessage(
  message: AgentConversationMessage,
  cached = false,
): unknown {
  switch (message.role) {
    case "user":
      return {
        content: chatContent(
          message.content,
          userAttachments(message).length === 0
            ? undefined
            : [
                ...textInputItems(message.content, "text"),
                ...userAttachments(message).map((attachment) =>
                  providerAttachmentInput(attachment, false),
                ),
              ],
          cached,
        ),
        role: "user",
      };
    case "assistant":
      return {
        content: chatContent(
          message.content.length === 0 ? null : message.content,
          undefined,
          cached,
        ),
        role: "assistant",
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                function: { arguments: call.arguments, name: call.name },
                id: call.id,
                type: "function",
              })),
            }),
      };
    case "compaction_notice":
      return undefined;
    case "tool":
      return {
        content: chatContent(message.content, undefined, cached),
        role: "tool",
        tool_call_id: message.toolCallId,
      };
  }
}

export function providerResponsesInput(
  message: AgentConversationMessage,
): readonly unknown[] {
  switch (message.role) {
    case "user":
      return [
        {
          content: [
            ...textInputItems(message.content, "input_text"),
            ...userAttachments(message).map((attachment) =>
              providerAttachmentInput(attachment, true),
            ),
          ],
          role: "user",
          type: "message",
        },
      ];
    case "assistant": {
      const textItems =
        message.content.length === 0
          ? []
          : [
              {
                content: [{ text: message.content, type: "output_text" }],
                role: "assistant",
                type: "message",
              },
            ];
      return [
        ...textItems,
        ...message.toolCalls.map((call) => ({
          arguments: call.arguments,
          call_id: call.id,
          name: call.name,
          type: "function_call",
        })),
      ];
    }
    case "compaction_notice":
      return [];
    case "tool":
      return [
        {
          call_id: message.toolCallId,
          output: message.content,
          type: "function_call_output",
        },
      ];
  }
}
