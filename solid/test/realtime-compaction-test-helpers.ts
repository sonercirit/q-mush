import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import {
  realtimeTestRig,
  type RealtimeTestRig,
} from "./realtime-test-helpers.ts";

export type RealtimeCompactionEvent = Extract<
  RealtimeServerEvent,
  { readonly type: "session_compaction" }
>;

export function realtimeCompactionTestRig(
  compactionSnapshot: () => void = () => undefined,
): RealtimeTestRig {
  return realtimeTestRig(compactionSnapshot);
}

export function compactionEvents(
  events: readonly RealtimeServerEvent[],
): readonly RealtimeCompactionEvent[] {
  return events.filter(
    (event): event is RealtimeCompactionEvent =>
      event.type === "session_compaction",
  );
}
