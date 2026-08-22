import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { SessionController } from "../session-controller.ts";

export function applySessionDelta(
  controller: SessionController,
  event: Extract<RealtimeServerEvent, { type: "session_delta" }>,
): void {
  controller.applyStreamBatch({
    type: "stream_batch",
    updates: [event],
  });
}
