import {
  agentAttachmentModality,
  type AgentAttachment,
  type AgentAttachmentModality,
} from "../shared/agent-attachments.ts";
import type { AgentModelOption } from "../shared/agent-configuration.ts";
import type { AgentConversationMessage } from "../shared/agent-loop.ts";
import {
  modelSupportsAttachmentModality,
  type AttachmentFallbackSelection,
} from "../shared/attachment-fallback.ts";

export type { AttachmentFallbackSelection } from "../shared/attachment-fallback.ts";

const ATTACHMENT_REFERENCE_SCHEME = "q-mush-attachment";

export interface AttachmentFallbackConversion {
  readonly reference: string;
  readonly text: string;
}

export function attachmentFallbackReference(
  modality: AgentAttachmentModality,
  name: string,
  id: string,
): string {
  return `${ATTACHMENT_REFERENCE_SCHEME}://${modality}/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
}

function fallbackSelection(
  selections: readonly AttachmentFallbackSelection[],
  modality: AgentAttachmentModality,
): AttachmentFallbackSelection {
  const selection = selections.find(
    (candidate) => candidate.modality === modality,
  );
  if (selection === undefined) {
    throw new Error(`No ${modality} fallback model is configured`);
  }
  return selection;
}

function attachmentMessage(
  attachment: AgentAttachment,
  conversion: AttachmentFallbackConversion,
): string {
  const modality = agentAttachmentModality(attachment);
  return `Attachment fallback (${modality}, ${attachment.name}): ${conversion.text}\nReference: ${conversion.reference}`;
}

function hasUserAttachments(
  message: AgentConversationMessage,
): message is Extract<AgentConversationMessage, { readonly role: "user" }> {
  return (
    message.role === "user" &&
    (message.attachments ?? message.images ?? []).length > 0
  );
}

type AttachmentConverter = (
  attachment: AgentAttachment,
  selection: AttachmentFallbackSelection,
) => Promise<AttachmentFallbackConversion>;

interface AttachmentPreparation {
  readonly convert: AttachmentConverter;
  readonly currentModel: AgentModelOption;
  readonly selections: readonly AttachmentFallbackSelection[];
}

interface UserAttachmentPreparation extends AttachmentPreparation {
  readonly message: Extract<
    AgentConversationMessage,
    { readonly role: "user" }
  >;
}

async function preparedUserMessage(
  options: UserAttachmentPreparation,
): Promise<AgentConversationMessage> {
  const native: AgentAttachment[] = [];
  const fallbackText: string[] = [];
  for (const attachment of options.message.attachments ??
    options.message.images ??
    []) {
    const modality = agentAttachmentModality(attachment);
    if (
      modelSupportsAttachmentModality(
        options.currentModel.inputModalities,
        modality,
      )
    ) {
      native.push(attachment);
      continue;
    }
    const conversion = await options.convert(
      attachment,
      fallbackSelection(options.selections, modality),
    );
    fallbackText.push(attachmentMessage(attachment, conversion));
  }
  const content = [options.message.content, ...fallbackText]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    ...(native.length === 0 ? {} : { attachments: native }),
    content,
    role: "user",
  };
}

export async function prepareAttachmentFallbacks(
  options: AttachmentPreparation & {
    readonly messages: readonly AgentConversationMessage[];
  },
): Promise<readonly AgentConversationMessage[]> {
  return Promise.all(
    options.messages.map((message) =>
      hasUserAttachments(message)
        ? preparedUserMessage({ ...options, message })
        : Promise.resolve(message),
    ),
  );
}
