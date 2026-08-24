import type {
  ToolStreamDeltaFrame,
  ToolStreamSnapshotFrame,
} from "../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { ToolSyncRequest } from "./realtime-client-tool-sync.ts";
import type {
  RealtimeStreamUpdate,
  RealtimeToolStreamUpdate,
  SessionStreamDelta,
} from "./realtime-stream-buffer-update.ts";

export type { RealtimeStreamUpdate, RealtimeToolStreamUpdate };
export type SessionDelta = SessionStreamDelta;
export type StreamServerEvent = SessionDelta | ToolStreamDeltaFrame;
export interface RealtimeStreamBatch {
  readonly type: "stream_batch";
  readonly updates: readonly RealtimeStreamUpdate[];
}
export type RealtimeClientEvent =
  Exclude<RealtimeServerEvent, StreamServerEvent> | RealtimeStreamBatch;
export interface RealtimeStreamBarrier {
  readonly epoch: number;
  readonly sessionId: string;
}
export interface RealtimeStreamBuffer {
  readonly pending: boolean;
  clear(): void;
  clearPending(): void;
  markBarrier(sessionId: string): RealtimeStreamBarrier;
  releaseBarrier(barrier: RealtimeStreamBarrier): void;
  activeToolStreams(sessionId?: string): readonly ToolSyncRequest[];
  takeToolResyncRequests(): readonly ToolSyncRequest[];
  clearToolSession(sessionId: string): void;
  queue(event: StreamServerEvent): void;
  takeNext(
    maximumUpdates?: number,
    selectedSessionId?: string,
    withinBudget?: () => boolean,
  ): RealtimeStreamBatch | undefined;
  takeBarrier(
    barrier: RealtimeStreamBarrier,
    maximumUpdates?: number,
    withinBudget?: () => boolean,
  ): RealtimeStreamBatch | undefined;
  barrierPending(barrier: RealtimeStreamBarrier): boolean;
  applyToolSnapshot(snapshot: ToolStreamSnapshotFrame): ToolStreamSnapshotFrame;
}
