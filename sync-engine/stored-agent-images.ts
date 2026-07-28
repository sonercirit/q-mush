import {
  readAgentAttachments,
  type AgentAttachment,
} from "../shared/agent-attachments.ts";

export function serializeStoredImages(
  images: readonly AgentAttachment[],
): string | null {
  return images.length === 0 ? null : JSON.stringify(images);
}

export function parseStoredImages(
  value: string | null,
  errorMessage: string,
): readonly AgentAttachment[] {
  if (value === null) {
    return [];
  }

  try {
    const images = readAgentAttachments(JSON.parse(value));
    if (images !== undefined) {
      return images;
    }
  } catch {
    // The caller's error identifies corrupt local data.
  }
  throw new Error(errorMessage);
}
