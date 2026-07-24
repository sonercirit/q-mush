import {
  appendCompactionPreviewText,
  COMPACTION_TERMINAL_HISTORY_MAX_OPERATIONS,
  type SessionCompactionRealtimeEvent,
} from "../shared/compaction-realtime.ts";

export interface CompactionPreview {
  readonly attempt: number;
  readonly operationId: string;
  readonly reasoning: string;
  readonly reasoningTruncated: boolean;
  readonly sequence: number;
  readonly sessionId: string;
  readonly summary: string;
  readonly summaryTruncated: boolean;
}

function isActiveOperation(
  current: CompactionPreview,
  event: SessionCompactionRealtimeEvent,
): boolean {
  return (
    current.operationId === event.operationId &&
    current.sessionId === event.sessionId
  );
}

function isTerminalPhase(
  phase: SessionCompactionRealtimeEvent["phase"],
): boolean {
  return phase === "cancel" || phase === "complete" || phase === "failure";
}

interface PreviewTransition {
  readonly current: CompactionPreview | undefined;
  readonly event: SessionCompactionRealtimeEvent;
  readonly selectedId: string | undefined;
}

function nextPreview({
  current,
  event,
  selectedId,
}: PreviewTransition): CompactionPreview | undefined {
  if (event.phase === "start") {
    return event.sessionId !== selectedId || current !== undefined
      ? current
      : {
          attempt: event.attempt,
          operationId: event.operationId,
          reasoning: "",
          reasoningTruncated: false,
          sequence: event.sequence,
          sessionId: event.sessionId,
          summary: "",
          summaryTruncated: false,
        };
  }
  if (
    current === undefined ||
    !isActiveOperation(current, event) ||
    event.sequence <= current.sequence ||
    event.attempt < current.attempt
  ) {
    return current;
  }
  if (isTerminalPhase(event.phase)) {
    return undefined;
  }
  if (event.phase === "reset") {
    return event.attempt <= current.attempt
      ? current
      : {
          ...current,
          attempt: event.attempt,
          reasoning: "",
          reasoningTruncated: false,
          sequence: event.sequence,
          summary: "",
          summaryTruncated: false,
        };
  }
  if (event.phase !== "delta" || event.attempt !== current.attempt) {
    return current;
  }

  const reasoning = appendCompactionPreviewText(
    current.reasoning,
    event.reasoning,
    current.reasoningTruncated,
  );
  const summary = appendCompactionPreviewText(
    current.summary,
    event.summary,
    current.summaryTruncated,
  );
  return {
    ...current,
    reasoning: reasoning.text,
    reasoningTruncated: reasoning.truncated,
    sequence: event.sequence,
    summary: summary.text,
    summaryTruncated: summary.truncated,
  };
}

export class SessionCompactionPreviewState {
  readonly #terminalOperations = new Set<string>();

  apply(
    current: CompactionPreview | undefined,
    event: SessionCompactionRealtimeEvent,
    selectedId: string | undefined,
  ): CompactionPreview | undefined {
    if (
      event.phase === "start" &&
      this.#terminalOperations.has(event.operationId)
    ) {
      return current;
    }
    const next = nextPreview({ current, event, selectedId });
    if (isTerminalPhase(event.phase)) {
      this.#rememberTerminal(event.operationId);
    }
    return next;
  }

  reset(): void {
    this.#terminalOperations.clear();
  }

  #rememberTerminal(operationId: string): void {
    this.#terminalOperations.add(operationId);
    while (
      this.#terminalOperations.size > COMPACTION_TERMINAL_HISTORY_MAX_OPERATIONS
    ) {
      const oldest = this.#terminalOperations.values().next().value;
      if (oldest === undefined) {
        return;
      }
      this.#terminalOperations.delete(oldest);
    }
  }
}
