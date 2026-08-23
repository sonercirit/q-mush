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
const fileAttachmentInput: AttachmentInput = (attachment, url, responses) =>
  responses
    ? { file_data: url, filename: attachment.name, type: "input_file" }
    : { file: { file_data: url, filename: attachment.name }, type: "file" };

const attachmentInputs = {
  audio: (attachment) => ({
    input_audio: {
      data: attachment.data,
      format: attachment.mediaType.split("/")[1] ?? "audio",
    },
    type: "input_audio",
  }),
  file: fileAttachmentInput,
  image: (_attachment, url, responses) =>
    responses
      ? { image_url: url, type: "input_image" }
      : { image_url: { url }, type: "image_url" },
  pdf: fileAttachmentInput,
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
type MessageHandler<Result> = Record<Role, () => Result>;

function messageHasRole<SelectedRole extends Role>(
  message: AgentConversationMessage,
  role: SelectedRole,
): message is Extract<
  AgentConversationMessage,
  { readonly role: SelectedRole }
> {
  return message.role === role;
}

function messageWithRole<SelectedRole extends Role>(
  message: AgentConversationMessage,
  role: SelectedRole,
): Extract<AgentConversationMessage, { readonly role: SelectedRole }> {
  if (!messageHasRole(message, role))
    throw new Error("Unexpected message role");
  return message;
}

function handleMessageRole<SelectedRole extends Role, Result>(
  message: AgentConversationMessage,
  role: SelectedRole,
  handler: (
    item: Extract<AgentConversationMessage, { readonly role: SelectedRole }>,
  ) => Result,
): Result {
  return handler(messageWithRole(message, role));
}

export function providerChatMessage(
  message: AgentConversationMessage,
  cached = false,
): unknown {
  const handlers = {
    assistant: () =>
      handleMessageRole(message, "assistant", (item) => ({
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
      })),
    compaction_notice: () => undefined,
    tool: () =>
      handleMessageRole(message, "tool", (item) => ({
        content: chatContent(item.content, undefined, cached),
        role: "tool",
        tool_call_id: item.toolCallId,
      })),
    user: () =>
      handleMessageRole(message, "user", (item) => ({
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
      })),
  } satisfies MessageHandler<unknown>;
  return handlers[message.role]();
}

export function providerResponsesInput(
  message: AgentConversationMessage,
): readonly unknown[] {
  const assistantInput = () =>
    handleMessageRole(message, "assistant", (item) => [
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
    ]);
  const handlers = {
    assistant: assistantInput,
    compaction_notice: () => [],
    tool: () =>
      handleMessageRole(message, "tool", (item) => [
        {
          call_id: item.toolCallId,
          output: item.content,
          type: "function_call_output",
        },
      ]),
    user: () =>
      handleMessageRole(message, "user", (item) => [
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
      ]),
  } satisfies MessageHandler<readonly unknown[]>;
  return handlers[message.role]();
}
