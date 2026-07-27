import { readAgentImages, type AgentImage } from "../shared/agent-images.ts";

export function serializeStoredImages(
  images: readonly AgentImage[],
): string | null {
  return images.length === 0 ? null : JSON.stringify(images);
}

export function parseStoredImages(
  value: string | null,
  errorMessage: string,
): readonly AgentImage[] {
  if (value === null) {
    return [];
  }

  try {
    const images = readAgentImages(JSON.parse(value));
    if (images !== undefined) {
      return images;
    }
  } catch {
    // The caller's error identifies corrupt local data.
  }
  throw new Error(errorMessage);
}
