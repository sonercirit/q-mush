import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import type {
  BufferedStreamUpdate,
  RealtimeStreamUpdate,
} from "./realtime-stream-buffer-update.ts";
import type { RealtimeStreamBatch } from "./realtime-stream-buffer.ts";
import type { RetainedToolState } from "./realtime-stream-tool-state.ts";
export function streamBatch(
  updates: readonly RealtimeStreamUpdate[],
): RealtimeStreamBatch | undefined {
  return updates.length === 0 ? undefined : { type: "stream_batch", updates };
}
export function updateEpoch(update: BufferedStreamUpdate): number {
  return update.value.epoch;
}
export function updatePendingBytes(update: BufferedStreamUpdate): number {
  return update.value.pendingBytes;
}
export function updateFragments(update: BufferedStreamUpdate): number {
  return update.value.fragments;
}
function pendingWithinLimit(
  updates: readonly RealtimeStreamUpdate[],
  maximumUpdates: number,
  withinBudget: () => boolean,
): boolean {
  return (
    updates.length < maximumUpdates && (updates.length === 0 || withinBudget())
  );
}
export function drainUpdates(
  maximumUpdates: number,
  withinBudget: () => boolean,
  take: () => RealtimeStreamUpdate | undefined,
): RealtimeStreamBatch | undefined {
  const updates: RealtimeStreamUpdate[] = [];
  while (pendingWithinLimit(updates, maximumUpdates, withinBudget)) {
    const update = take();
    if (update === undefined) break;
    updates.push(update);
  }
  return streamBatch(updates);
}
export function retainedToolEntry(
  local: RetainedToolState | undefined,
  received: ToolStreamEntry,
): ToolStreamEntry | undefined {
  if (local?.kind === "terminal") return undefined;
  if (local === undefined) return received;
  return local.entry.sequence >= received.sequence ? local.entry : received;
}
