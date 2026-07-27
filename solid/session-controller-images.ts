import type { AgentImage } from "../shared/agent-images.ts";
import { appendAgentImageFiles } from "./session-image-input.ts";

export async function updatedSessionImages(
  files: readonly File[],
  images: readonly AgentImage[],
): Promise<readonly AgentImage[]> {
  return appendAgentImageFiles(images, files);
}

export function removeSessionImage(
  images: readonly AgentImage[],
  index: number,
): readonly AgentImage[] | undefined {
  return Number.isSafeInteger(index) && index >= 0 && index < images.length
    ? images.filter((_image, imageIndex) => imageIndex !== index)
    : undefined;
}
