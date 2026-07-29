import { isRecord } from "./auth-model.ts";

export const AGENT_ATTACHMENT_MODALITIES = [
  "image",
  "video",
  "audio",
  "pdf",
  "file",
] as const;
export type AgentAttachmentModality =
  (typeof AGENT_ATTACHMENT_MODALITIES)[number];

export const AGENT_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "application/pdf",
  "application/gzip",
  "application/javascript",
  "application/json",
  "application/octet-stream",
  "application/rtf",
  "application/sql",
  "application/toml",
  "application/xml",
  "application/yaml",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "text/css",
  "text/csv",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/rtf",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
] as const;
export type AgentAttachmentMediaType =
  (typeof AGENT_ATTACHMENT_MEDIA_TYPES)[number];

export const MAXIMUM_AGENT_ATTACHMENTS = 8;
export const MAXIMUM_AGENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAXIMUM_AGENT_ATTACHMENT_NAME_LENGTH = 255;
const BASE64_PATTERN =
  /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

export interface AgentAttachment {
  readonly data: string;
  readonly mediaType: AgentAttachmentMediaType;
  readonly name: string;
}

export function agentAttachmentMediaTypeFromName(
  name: string,
): AgentAttachmentMediaType {
  const extension = name.toLowerCase().split(".").at(-1);
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mp3":
      return "audio/mpeg";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "pdf":
      return "application/pdf";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "xml":
      return "application/xml";
    case "yaml":
    case "yml":
      return "application/yaml";
    case "zip":
      return "application/zip";
    case undefined:
    default:
      return "application/octet-stream";
  }
}

export function isAgentAttachmentMediaType(
  value: unknown,
): value is AgentAttachmentMediaType {
  return AGENT_ATTACHMENT_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

export function agentAttachmentModality(
  attachment: Pick<AgentAttachment, "mediaType">,
): AgentAttachmentModality {
  if (attachment.mediaType.startsWith("image/")) return "image";
  if (attachment.mediaType.startsWith("video/")) return "video";
  if (attachment.mediaType.startsWith("audio/")) return "audio";
  return attachment.mediaType === "application/pdf" ? "pdf" : "file";
}

function readAgentAttachment(value: unknown): AgentAttachment | undefined {
  if (!isRecord(value)) return undefined;
  const data = value["data"];
  const mediaType = value["mediaType"];
  const name = value["name"];
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !BASE64_PATTERN.test(data) ||
    !isAgentAttachmentMediaType(mediaType) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAXIMUM_AGENT_ATTACHMENT_NAME_LENGTH ||
    name.includes("\0")
  ) {
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(data);
  } catch {
    return undefined;
  }
  return bytes.length > 0 &&
    bytes.length <= MAXIMUM_AGENT_ATTACHMENT_BYTES &&
    bytes.toBase64() === data
    ? { data, mediaType, name }
    : undefined;
}

export function readAgentAttachments(
  value: unknown,
): readonly AgentAttachment[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_AGENT_ATTACHMENTS) {
    return undefined;
  }
  const attachments: AgentAttachment[] = [];
  for (const item of value) {
    const attachment = readAgentAttachment(item);
    if (attachment === undefined) return undefined;
    attachments.push(attachment);
  }
  return attachments;
}

export function agentAttachmentDataUrl(attachment: AgentAttachment): string {
  return `data:${attachment.mediaType};base64,${attachment.data}`;
}
