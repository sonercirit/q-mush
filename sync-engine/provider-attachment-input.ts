import {
  agentAttachmentDataUrl,
  agentAttachmentModality,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";

function textInputItems(
  content: string,
  type: "input_text" | "text",
): readonly unknown[] {
  return content.length === 0 ? [] : [{ text: content, type }];
}

function userAttachments(
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

export function providerChatMessage(
  message: AgentConversationMessage,
): unknown {
  switch (message.role) {
    case "user":
      return {
        content:
          userAttachments(message).length === 0
            ? message.content
            : [
                ...textInputItems(message.content, "text"),
                ...userAttachments(message).map((attachment) =>
                  providerAttachmentInput(attachment, false),
                ),
              ],
        role: "user",
      };
    case "assistant":
      return {
        content: message.content.length === 0 ? null : message.content,
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
    case "tool":
      return {
        content: message.content,
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
