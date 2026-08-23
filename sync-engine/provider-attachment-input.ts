import {
  agentAttachmentDataUrl,
  agentAttachmentModality,
  type AgentAttachment,
  type AgentAttachmentModality,
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

type AttachmentInput = (
  attachment: AgentAttachment,
  url: string,
  responses: boolean,
) => unknown;
const attachmentInputs = {
  audio: (attachment) => ({
    input_audio: {
      data: attachment.data,
      format: attachment.mediaType.split("/")[1] ?? "audio",
    },
    type: "input_audio",
  }),
  file: (attachment, url, responses) =>
    responses
      ? { file_data: url, filename: attachment.name, type: "input_file" }
      : { file: { file_data: url, filename: attachment.name }, type: "file" },
  image: (_attachment, url, responses) =>
    responses
      ? { image_url: url, type: "input_image" }
      : { image_url: { url }, type: "image_url" },
  pdf: (attachment, url, responses) =>
    responses
      ? { file_data: url, filename: attachment.name, type: "input_file" }
      : { file: { file_data: url, filename: attachment.name }, type: "file" },
  video: (_attachment, url, responses) =>
    responses
      ? { video_url: url, type: "input_video" }
      : { type: "video_url", video_url: { url } },
} satisfies Record<AgentAttachmentModality, AttachmentInput>;

function providerAttachmentInput(
  attachment: AgentAttachment,
  responses: boolean,
): unknown {
  const modality = agentAttachmentModality(attachment);
  return attachmentInputs[modality](
    attachment,
    agentAttachmentDataUrl(attachment),
    responses,
  );
}

function chatContent(
  content: string | null,
  parts: readonly unknown[] | undefined,
  cached: boolean,
): unknown {
  if (!cached) return parts ?? content;
  const items =
    parts ??
    (typeof content === "string" ? textInputItems(content, "text") : []);
  return items.length === 0 ? content : withPromptCacheControl(items);
}

type Role = AgentConversationMessage["role"];
type MessageHandler<Result> = {
  [Kind in Role]: (
    message: Extract<AgentConversationMessage, { readonly role: Kind }>,
  ) => Result;
};

export function providerChatMessage(
  message: AgentConversationMessage,
  cached = false,
): unknown {
  const handlers = {
    assistant: (item) => ({
      content: chatContent(
        item.content.length === 0 ? null : item.content,
        undefined,
        cached,
      ),
      role: "assistant",
      ...(item.toolCalls.length === 0
        ? {}
        : {
            tool_calls: item.toolCalls.map((call) => ({
              function: { arguments: call.arguments, name: call.name },
              id: call.id,
              type: "function",
            })),
          }),
    }),
    compaction_notice: () => undefined,
    tool: (item) => ({
      content: chatContent(item.content, undefined, cached),
      role: "tool",
      tool_call_id: item.toolCallId,
    }),
    user: (item) => ({
      content: chatContent(
        item.content,
        userAttachments(item).length === 0
          ? undefined
          : [
              ...textInputItems(item.content, "text"),
              ...userAttachments(item).map((attachment) =>
                providerAttachmentInput(attachment, false),
              ),
            ],
        cached,
      ),
      role: "user",
    }),
  } satisfies MessageHandler<unknown>;
  return handlers[message.role](message as never);
}

export function providerResponsesInput(
  message: AgentConversationMessage,
): readonly unknown[] {
  const handlers = {
    assistant: (item) => [
      ...(item.content.length === 0
        ? []
        : [
            {
              content: [{ text: item.content, type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ]),
      ...item.toolCalls.map((call) => ({
        arguments: call.arguments,
        call_id: call.id,
        name: call.name,
        type: "function_call",
      })),
    ],
    compaction_notice: () => [],
    tool: (item) => [
      {
        call_id: item.toolCallId,
        output: item.content,
        type: "function_call_output",
      },
    ],
    user: (item) => [
      {
        content: [
          ...textInputItems(item.content, "input_text"),
          ...userAttachments(item).map((attachment) =>
            providerAttachmentInput(attachment, true),
          ),
        ],
        role: "user",
        type: "message",
      },
    ],
  } satisfies MessageHandler<readonly unknown[]>;
  return handlers[message.role](message as never);
}
