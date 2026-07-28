import { readAgentAttachments } from "../shared/agent-attachments.ts";
import { readNullableString } from "../shared/auth-model.ts";
import type { AttachmentContentFields } from "../shared/session-model.ts";
import { readFiniteNumber } from "../shared/validation.ts";

export interface SessionContentFields extends AttachmentContentFields {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
}

export interface SessionMessageFields extends SessionContentFields {
  readonly toolCallId: string | null;
  readonly toolName: string | null;
}

export function readSessionContentFields(
  value: Readonly<Record<string, unknown>>,
): SessionContentFields | undefined {
  const content = value["content"];
  const createdAt = readFiniteNumber(value["createdAt"]);
  const id = value["id"];
  const attachments = readAgentAttachments(
    value["attachments"] ?? value["images"],
  );
  return typeof content === "string" &&
    createdAt !== undefined &&
    typeof id === "string" &&
    attachments !== undefined
    ? {
        ...(value["attachments"] === undefined ? {} : { attachments }),
        content,
        createdAt,
        id,
        images: attachments,
      }
    : undefined;
}

export function readSessionMessageFields(
  value: Readonly<Record<string, unknown>>,
): SessionMessageFields | undefined {
  const contentFields = readSessionContentFields(value);
  const toolCallId = readNullableString(value["toolCallId"]);
  const toolName = readNullableString(value["toolName"]);
  return contentFields !== undefined &&
    toolCallId !== undefined &&
    toolName !== undefined
    ? { ...contentFields, toolCallId, toolName }
    : undefined;
}
