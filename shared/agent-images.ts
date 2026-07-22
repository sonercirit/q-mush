import { isRecord } from "./auth-model.ts";

export const AGENT_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type AgentImageMediaType = (typeof AGENT_IMAGE_MEDIA_TYPES)[number];

export const MAXIMUM_AGENT_IMAGES = 8;
export const MAXIMUM_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAXIMUM_AGENT_IMAGE_NAME_LENGTH = 255;
const BASE64_PATTERN =
  /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

export interface AgentImage {
  readonly data: string;
  readonly mediaType: AgentImageMediaType;
  readonly name: string;
}

export function isAgentImageMediaType(
  value: unknown,
): value is AgentImageMediaType {
  return AGENT_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

function readAgentImage(value: unknown): AgentImage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const data = value["data"];
  const mediaType = value["mediaType"];
  const name = value["name"];

  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !BASE64_PATTERN.test(data) ||
    !isAgentImageMediaType(mediaType) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAXIMUM_AGENT_IMAGE_NAME_LENGTH ||
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

  if (
    bytes.length === 0 ||
    bytes.length > MAXIMUM_AGENT_IMAGE_BYTES ||
    bytes.toBase64() !== data
  ) {
    return undefined;
  }

  return { data, mediaType, name };
}

export function readAgentImages(
  value: unknown,
): readonly AgentImage[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > MAXIMUM_AGENT_IMAGES) {
    return undefined;
  }

  const images: AgentImage[] = [];
  for (const item of value) {
    const image = readAgentImage(item);
    if (image === undefined) {
      return undefined;
    }
    images.push(image);
  }
  return images;
}

export function agentImageDataUrl(image: AgentImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
