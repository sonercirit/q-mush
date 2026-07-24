import {
  splitCompactionRealtimeDelta,
  type SessionCompactionRealtimeEvent,
} from "../shared/compaction-realtime.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export type CompactionDeltaListener = (delta: ProviderTextDelta) => void;

export type CompactionLifecycleListener = (
  event: SessionCompactionRealtimeEvent,
) => void;

export interface CompactionRealtimeLifecycle {
  readonly onDelta: CompactionDeltaListener;
  cancel(): void;
  complete(): void;
  fail(): void;
  start(): void;
}

export function createCompactionRealtimeLifecycle(options: {
  readonly listener: CompactionLifecycleListener;
  readonly operationId: string;
  readonly sessionId: string;
}): CompactionRealtimeLifecycle {
  let attempt = 0;
  let sequence = 0;
  let started = false;
  let terminal = false;

  const emit = (
    event:
      | { readonly phase: "start" }
      | { readonly phase: "reset" }
      | {
          readonly phase: "delta";
          readonly reasoning: string;
          readonly summary: string;
        }
      | { readonly phase: "cancel" | "complete" | "failure" },
  ): void => {
    options.listener({
      attempt,
      operationId: options.operationId,
      ...event,
      sequence,
      sessionId: options.sessionId,
      type: "session_compaction",
    });
    sequence += 1;
  };
  const finish = (phase: "cancel" | "complete" | "failure"): void => {
    if (!started || terminal) {
      return;
    }
    terminal = true;
    emit({ phase });
  };

  return {
    cancel: () => {
      finish("cancel");
    },
    complete: () => {
      finish("complete");
    },
    fail: () => {
      finish("failure");
    },
    onDelta: (delta) => {
      if (!started || terminal) {
        return;
      }
      if (delta.reset === true) {
        attempt += 1;
        emit({ phase: "reset" });
        return;
      }
      if (delta.content.length > 0 || delta.thinking.length > 0) {
        for (const chunk of splitCompactionRealtimeDelta(
          delta.thinking,
          delta.content,
        )) {
          emit({
            phase: "delta",
            reasoning: chunk.reasoning,
            summary: chunk.summary,
          });
        }
      }
    },
    start: () => {
      if (started || terminal) {
        return;
      }
      started = true;
      emit({ phase: "start" });
    },
  };
}
