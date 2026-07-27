import { readAgentImages } from "../shared/agent-images.ts";
import { readNullableString } from "../shared/auth-model.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import { readFiniteNumber } from "../shared/validation.ts";

export interface SessionContentFields {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
  readonly images: AgentSessionMessage["images"];
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
  const images = readAgentImages(value["images"]);
  return typeof content === "string" &&
    createdAt !== undefined &&
    typeof id === "string" &&
    images !== undefined
    ? { content, createdAt, id, images }
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
