import {
  AGENT_ATTACHMENT_MEDIA_TYPES,
  isAgentAttachmentMediaType,
  MAXIMUM_AGENT_ATTACHMENT_BYTES,
  MAXIMUM_AGENT_ATTACHMENT_NAME_LENGTH,
  MAXIMUM_AGENT_ATTACHMENTS,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";

export const AGENT_ATTACHMENT_ACCEPT = AGENT_ATTACHMENT_MEDIA_TYPES.join(",");

interface ClipboardAttachmentData {
  readonly files: Iterable<File>;
  readonly items: Iterable<{ getAsFile(): File | null; readonly kind: string }>;
}

interface AttachmentPasteEvent {
  readonly clipboardData: ClipboardAttachmentData | null;
  preventDefault(): void;
}

function normalizedMediaType(value: string): string {
  const normalized = value.split(";", 1)[0]?.trim() ?? "";
  return normalized.length === 0 ? "application/octet-stream" : normalized;
}

function namedPastedFile(file: File): File {
  if (file.name.length > 0) return file;
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
  const base = file.type.startsWith("image/")
    ? "pasted-image"
    : "pasted-attachment";
  return new File([file], `${base}.${extension}`, { type: file.type });
}

export function readPastedAgentAttachmentFiles(
  event: AttachmentPasteEvent,
): readonly File[] {
  if (event.clipboardData === null) return [];
  const itemFiles = [...event.clipboardData.items]
    .filter(({ kind }) => kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const files = (
    itemFiles.length > 0 ? itemFiles : [...event.clipboardData.files]
  )
    .filter(({ type }) => isAgentAttachmentMediaType(normalizedMediaType(type)))
    .map(namedPastedFile);
  if (files.length > 0) event.preventDefault();
  return files;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function readAgentAttachmentFile(file: File): Promise<AgentAttachment> {
  const mediaType = normalizedMediaType(file.type);
  if (!isAgentAttachmentMediaType(mediaType)) {
    throw new Error(
      "Choose a supported image, video, audio, PDF, text, document, archive, or generic file.",
    );
  }
  if (file.size === 0 || file.size > MAXIMUM_AGENT_ATTACHMENT_BYTES) {
    throw new Error(
      "Each attachment must be non-empty and no larger than 10 MB.",
    );
  }
  if (
    file.name.length === 0 ||
    file.name.length > MAXIMUM_AGENT_ATTACHMENT_NAME_LENGTH ||
    file.name.includes("\0")
  ) {
    throw new Error(
      "Each attachment must have a safe name up to 255 characters.",
    );
  }
  return {
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    mediaType,
    name: file.name,
  };
}

export async function appendAgentAttachmentFiles(
  current: readonly AgentAttachment[],
  files: readonly File[],
): Promise<readonly AgentAttachment[]> {
  if (current.length + files.length > MAXIMUM_AGENT_ATTACHMENTS) {
    throw new Error(
      `Attach no more than ${String(MAXIMUM_AGENT_ATTACHMENTS)} files.`,
    );
  }
  return [
    ...current,
    ...(await Promise.all(files.map(readAgentAttachmentFile))),
  ];
}
