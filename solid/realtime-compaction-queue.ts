import {
  appendCompactionPreviewText,
  COMPACTION_QUEUE_MAX_OPERATIONS,
} from "../shared/compaction-realtime.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";

type RealtimeCompactionEvent = Extract<
  RealtimeServerEvent,
  { readonly type: "session_compaction" }
>;

type RealtimeCompactionListener = (event: RealtimeCompactionEvent) => void;

interface CompactionDelta {
  readonly attempt: number;
  readonly operationId: string;
  readonly reasoning: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly summary: string;
}

export interface RealtimeCompactionSnapshot {
  readonly type: "compaction_snapshot";
}

function queuedText(
  current: CompactionDelta | undefined,
  event: Extract<RealtimeCompactionEvent, { readonly phase: "delta" }>,
  channel: "reasoning" | "summary",
): string {
  const prior =
    current?.attempt === event.attempt && current.sequence < event.sequence
      ? current[channel]
      : "";
  return appendCompactionPreviewText(prior, event[channel]).text;
}

export class RealtimeCompactionQueue {
  readonly #snapshot: (event: RealtimeCompactionSnapshot) => void;
  readonly #requestFrame: (callback: () => void) => number;
  readonly #listener: RealtimeCompactionListener;
  #frame: number | undefined;
  #generation = 0;
  readonly #pending = new Map<string, CompactionDelta>();

  constructor(
    listener: RealtimeCompactionListener,
    requestFrame: (callback: () => void) => number,
    snapshot: (event: RealtimeCompactionSnapshot) => void,
  ) {
    this.#listener = listener;
    this.#requestFrame = requestFrame;
    this.#snapshot = snapshot;
  }

  clear(): void {
    this.#generation += 1;
    this.#frame = undefined;
    this.#pending.clear();
  }

  reset(): void {
    this.#snapshot({ type: "compaction_snapshot" });
    this.clear();
  }

  flushSession(sessionId: string): void {
    const keys = [...this.#pending.keys()].filter((key) =>
      key.startsWith(`${sessionId}\u0000`),
    );
    for (const key of keys) {
      const event = this.#pending.get(key);
      this.#pending.delete(key);
      if (event !== undefined) {
        this.#listener({
          ...event,
          phase: "delta",
          type: "session_compaction",
        });
      }
    }
  }

  push(event: RealtimeCompactionEvent): void {
    if (event.phase !== "delta") {
      this.flushSession(event.sessionId);
      this.#listener(event);
      return;
    }

    const key = `${event.sessionId}\u0000${event.operationId}`;
    const current = this.#pending.get(key);
    if (
      current !== undefined &&
      (event.attempt < current.attempt ||
        (event.attempt === current.attempt &&
          event.sequence <= current.sequence))
    ) {
      return;
    }
    const combined: CompactionDelta = {
      ...event,
      reasoning: queuedText(current, event, "reasoning"),
      summary: queuedText(current, event, "summary"),
    };
    this.#pending.set(key, combined);
    while (this.#pending.size > COMPACTION_QUEUE_MAX_OPERATIONS) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#pending.delete(oldest);
    }
    if (this.#frame !== undefined) {
      return;
    }

    const generation = this.#generation;
    this.#frame = this.#requestFrame(() => {
      if (generation !== this.#generation) {
        return;
      }
      this.#frame = undefined;
      const events = [...this.#pending.values()];
      this.#pending.clear();
      for (const queued of events) {
        this.#listener({
          ...queued,
          phase: "delta",
          type: "session_compaction",
        });
      }
    });
  }
}
