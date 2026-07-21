import {
  AGENT_IMAGE_MEDIA_TYPES,
  isAgentImageMediaType,
  MAXIMUM_AGENT_IMAGE_BYTES,
  MAXIMUM_AGENT_IMAGE_NAME_LENGTH,
  MAXIMUM_AGENT_IMAGES,
  type AgentImage,
} from "./agent-images.ts";

export const AGENT_IMAGE_ACCEPT = AGENT_IMAGE_MEDIA_TYPES.join(",");

interface ClipboardImageData {
  readonly files: Iterable<File>;
  readonly items: Iterable<{
    getAsFile(): File | null;
    readonly kind: string;
  }>;
}

interface ImagePasteEvent {
  readonly clipboardData: ClipboardImageData | null;
  preventDefault(): void;
}

function namedPastedImage(file: File): File {
  if (file.name.length > 0) {
    return file;
  }

  const subtype = file.type.slice("image/".length);
  const extension = subtype === "jpeg" ? "jpg" : subtype;
  return new File([file], `pasted-image.${extension}`, { type: file.type });
}

export function readPastedAgentImageFiles(
  event: ImagePasteEvent,
): readonly File[] {
  if (event.clipboardData === null) {
    return [];
  }

  const itemFiles = [...event.clipboardData.items]
    .filter(({ kind }) => kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  const files =
    itemFiles.length > 0 ? itemFiles : [...event.clipboardData.files];
  const images = files
    .filter(({ type }) => type.startsWith("image/"))
    .map(namedPastedImage);

  if (images.length > 0) {
    event.preventDefault();
  }

  return images;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }

  return btoa(binary);
}

async function readAgentImageFile(file: File): Promise<AgentImage> {
  if (!isAgentImageMediaType(file.type)) {
    throw new Error("Choose a PNG, JPEG, GIF, or WebP image.");
  }
  if (file.size === 0 || file.size > MAXIMUM_AGENT_IMAGE_BYTES) {
    throw new Error("Each image must be non-empty and no larger than 10 MB.");
  }
  if (
    file.name.length === 0 ||
    file.name.length > MAXIMUM_AGENT_IMAGE_NAME_LENGTH ||
    file.name.includes("\0")
  ) {
    throw new Error(
      "Each image must have a name no longer than 255 characters.",
    );
  }

  return {
    data: encodeBase64(new Uint8Array(await file.arrayBuffer())),
    mediaType: file.type,
    name: file.name,
  };
}

export async function appendAgentImageFiles(
  current: readonly AgentImage[],
  files: readonly File[],
): Promise<readonly AgentImage[]> {
  if (current.length + files.length > MAXIMUM_AGENT_IMAGES) {
    throw new Error(
      `Attach no more than ${String(MAXIMUM_AGENT_IMAGES)} images.`,
    );
  }

  return [...current, ...(await Promise.all(files.map(readAgentImageFile)))];
}
