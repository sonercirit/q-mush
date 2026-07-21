import {
  AGENT_IMAGE_MEDIA_TYPES,
  isAgentImageMediaType,
  MAXIMUM_AGENT_IMAGE_BYTES,
  MAXIMUM_AGENT_IMAGE_NAME_LENGTH,
  MAXIMUM_AGENT_IMAGES,
  type AgentImage,
} from "./agent-images.ts";

export const AGENT_IMAGE_ACCEPT = AGENT_IMAGE_MEDIA_TYPES.join(",");

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
