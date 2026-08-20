import { readAgentAttachments } from "../shared/agent-attachments.ts";
import type { AgentTokenUsage } from "../shared/agent-loop.ts";
import { isRecord, readNullableString } from "../shared/auth-model.ts";
import type { AttachmentContentFields } from "../shared/session-model.ts";
import {
  readFiniteNumber,
  readNonNegativeSafeInteger,
} from "../shared/validation.ts";

export interface SessionContentFields extends AttachmentContentFields {
  readonly content: string;
  readonly createdAt: number;
  readonly id: string;
}

export interface SessionMessageFields extends SessionContentFields {
  readonly tokenUsage?: AgentTokenUsage;
  readonly toolCallId: string | null;
  readonly toolName: string | null;
  readonly turnId?: string | null;
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
  const tokenUsage = readTokenUsage(value["tokenUsage"]);
  const toolCallId = readNullableString(value["toolCallId"]);
  const toolName = readNullableString(value["toolName"]);
  const turnId = readNullableString(value["turnId"] ?? null);
  return contentFields !== undefined &&
    tokenUsage !== undefined &&
    toolCallId !== undefined &&
    toolName !== undefined &&
    turnId !== undefined
    ? {
        ...contentFields,
        ...(tokenUsage === null ? {} : { tokenUsage }),
        toolCallId,
        toolName,
        ...(value["turnId"] === undefined ? {} : { turnId }),
      }
    : undefined;
}

function readTokenUsage(value: unknown): AgentTokenUsage | null | undefined {
  const normalized = value === null ? undefined : value;
  if (normalized === undefined) return null;
  if (!isRecord(normalized)) return undefined;
  const cacheWriteInputTokens = readTokenCount(
    normalized["cacheWriteInputTokens"],
  );
  const cachedInputTokens = readTokenCount(normalized["cachedInputTokens"]);
  const inputTokens = readTokenCount(normalized["inputTokens"]);
  const outputTokens = readTokenCount(normalized["outputTokens"]);
  return cacheWriteInputTokens === undefined ||
    cachedInputTokens === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined
    ? undefined
    : {
        cacheWriteInputTokens,
        cachedInputTokens,
        inputTokens,
        outputTokens,
      };
}

function readTokenCount(value: unknown): number | undefined {
  return readNonNegativeSafeInteger(value);
}
