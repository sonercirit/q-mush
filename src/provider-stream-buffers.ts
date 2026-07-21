import type { ProviderTextDelta } from "./provider-stream.ts";

export interface StreamBuffers {
  readonly onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly text: string[];
  readonly thinking: string[];
}

export function createStreamBuffers(
  onDelta?: (delta: ProviderTextDelta) => void,
): StreamBuffers {
  return { onDelta, text: [], thinking: [] };
}
