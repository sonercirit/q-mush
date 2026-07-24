const COMPACTION_DELTA_MAX_LENGTH = 16_384;
const COMPACTION_PREVIEW_MAX_LENGTH = 131_072;
export const COMPACTION_QUEUE_MAX_OPERATIONS = 8;
export const COMPACTION_TERMINAL_HISTORY_MAX_OPERATIONS = 32;

export type RealtimeUserPublisher = (
  userId: string,
  payload: Readonly<Record<string, unknown>>,
) => void;

interface SessionCompactionEventBase {
  readonly attempt: number;
  readonly operationId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: "session_compaction";
}

export type SessionCompactionRealtimeEvent =
  | (SessionCompactionEventBase & { readonly phase: "start" })
  | (SessionCompactionEventBase & { readonly phase: "reset" })
  | (SessionCompactionEventBase & {
      readonly phase: "delta";
      readonly reasoning: string;
      readonly summary: string;
    })
  | (SessionCompactionEventBase & {
      readonly phase: "cancel" | "complete" | "failure";
    });

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function validBase(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & SessionCompactionEventBase {
  return (
    value["type"] === "session_compaction" &&
    typeof value["operationId"] === "string" &&
    value["operationId"].length > 0 &&
    value["operationId"].length <= 200 &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"].length > 0 &&
    value["sessionId"].length <= 200 &&
    typeof value["attempt"] === "number" &&
    Number.isSafeInteger(value["attempt"]) &&
    value["attempt"] >= 0 &&
    typeof value["sequence"] === "number" &&
    Number.isSafeInteger(value["sequence"]) &&
    value["sequence"] >= 0
  );
}

export function readSessionCompactionRealtimeEvent(
  value: Readonly<Record<string, unknown>>,
): SessionCompactionRealtimeEvent {
  if (!validBase(value)) {
    throw new Error("The compaction realtime event was invalid");
  }

  const base: SessionCompactionEventBase = {
    attempt: value.attempt,
    operationId: value.operationId,
    sequence: value.sequence,
    sessionId: value.sessionId,
    type: "session_compaction",
  };
  switch (value["phase"]) {
    case "start":
      if (base.attempt === 0 && base.sequence === 0) {
        return { ...base, phase: "start" };
      }
      break;
    case "reset":
      if (base.attempt > 0 && base.sequence > 0) {
        return { ...base, phase: "reset" };
      }
      break;
    case "delta": {
      const reasoning = value["reasoning"];
      const summary = value["summary"];
      if (
        base.sequence > 0 &&
        isBoundedString(reasoning, COMPACTION_DELTA_MAX_LENGTH) &&
        isBoundedString(summary, COMPACTION_DELTA_MAX_LENGTH) &&
        (reasoning.length > 0 || summary.length > 0)
      ) {
        return { ...base, phase: "delta", reasoning, summary };
      }
      break;
    }
    case "cancel":
    case "complete":
    case "failure":
      if (base.sequence > 0) {
        return { ...base, phase: value["phase"] };
      }
      break;
  }

  throw new Error("The compaction realtime event was invalid");
}

export function splitCompactionRealtimeDelta(
  reasoning: string,
  summary: string,
): readonly { readonly reasoning: string; readonly summary: string }[] {
  const chunks = Math.max(
    Math.ceil(reasoning.length / COMPACTION_DELTA_MAX_LENGTH),
    Math.ceil(summary.length / COMPACTION_DELTA_MAX_LENGTH),
  );
  return Array.from({ length: chunks }, (_unused, index) => {
    const start = index * COMPACTION_DELTA_MAX_LENGTH;
    const end = start + COMPACTION_DELTA_MAX_LENGTH;
    return {
      reasoning: reasoning.slice(start, end),
      summary: summary.slice(start, end),
    };
  });
}

export interface BoundedCompactionText {
  readonly text: string;
  readonly truncated: boolean;
}

export function appendCompactionPreviewText(
  current: string,
  delta: string,
  truncated = false,
): BoundedCompactionText {
  if (truncated) {
    return { text: current, truncated };
  }
  const remaining = Math.max(0, COMPACTION_PREVIEW_MAX_LENGTH - current.length);
  const accepted = delta.slice(0, remaining);
  return {
    text: current + accepted,
    truncated: accepted.length < delta.length,
  };
}
