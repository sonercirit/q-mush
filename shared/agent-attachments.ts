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

const AGENT_ATTACHMENT_EXTENSION_MEDIA_TYPES = {
  csv: "text/csv",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
} satisfies Record<string, AgentAttachmentMediaType>;
type AgentAttachmentExtension =
  keyof typeof AGENT_ATTACHMENT_EXTENSION_MEDIA_TYPES;

function isAgentAttachmentExtension(
  value: string | undefined,
): value is AgentAttachmentExtension {
  return (
    value !== undefined &&
    Object.hasOwn(AGENT_ATTACHMENT_EXTENSION_MEDIA_TYPES, value)
  );
}

export function agentAttachmentMediaTypeFromName(
  name: string,
): AgentAttachmentMediaType {
  const extension = name.toLowerCase().split(".").at(-1);
  return isAgentAttachmentExtension(extension)
    ? AGENT_ATTACHMENT_EXTENSION_MEDIA_TYPES[extension]
    : "application/octet-stream";
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
