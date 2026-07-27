import type { ToolStreamEntry } from "../shared/tool-stream.ts";

export function toolStreamKey(
  entry: Pick<ToolStreamEntry, "index" | "streamId">,
): string {
  return `${entry.streamId}:${String(entry.index)}`;
}
