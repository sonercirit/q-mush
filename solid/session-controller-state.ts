import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type {
  RealtimeStreamBatch,
  RealtimeStreamUpdate,
  RealtimeToolStreamUpdate,
} from "./realtime-stream-buffer.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import {
  persistedDetail,
  persistedMessages,
  reconcileStream,
  resolveStreamBase,
  retainCompactionStream,
  sessionDetailIsActive,
  streamMessages,
  streamedContent,
  type StreamedSessionContent,
} from "./session-controller-stream.ts";
import {
  replaceSessionSummary,
  retainUnchangedSessionData,
  sessionDataMatches,
  sessionSummariesMatch,
} from "./session-data-matching.ts";
import { createDisplaySessionMessage } from "./session-message.ts";
import { sessionMutationPending } from "./session-pending.ts";
import { toolStreamKey } from "./tool-stream-client.ts";

const MAXIMUM_STREAMED_SESSIONS_PER_USER = 100;
const MAXIMUM_PROTECTED_STREAMED_SESSIONS = 2;

function assertStreamRetentionCapacity(maximum: number): void {
  if (maximum < MAXIMUM_PROTECTED_STREAMED_SESSIONS) {
    throw new Error(
      "The streamed-session cap must accommodate the selected and rendered sessions",
    );
  }
}

assertStreamRetentionCapacity(MAXIMUM_STREAMED_SESSIONS_PER_USER);

function replaceToolStream(
  streams: readonly ToolStreamEntry[],
  update: RealtimeToolStreamUpdate,
): readonly ToolStreamEntry[] {
  const key = toolStreamKey(update.entry);
  const retained = streams.filter((entry) => toolStreamKey(entry) !== key);
  return update.terminal
    ? retained
    : [...retained, update.entry].sort(
        (left, right) => left.index - right.index,
      );
}

function toolStreamsMatch(
  left: readonly ToolStreamEntry[],
  right: readonly ToolStreamEntry[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, entry] of left.entries()) {
    if (entry !== right[index]) return false;
  }
  return true;
}

export class SessionRealtimeState {
  readonly #compactionRequests = new Map<string, AgentSessionMessage>();
  readonly #mutationRebases = new Set<string>();
  readonly #streamedContent = new Map<string, StreamedSessionContent>();
  readonly #view: RevisionState<SessionViewState>;

  #retainStreamedContent(
    sessionId: string,
    content: StreamedSessionContent,
  ): void {
    this.#streamedContent.delete(sessionId);
    this.#streamedContent.set(sessionId, content);
    const view = this.#view.value;
    while (this.#streamedContent.size > MAXIMUM_STREAMED_SESSIONS_PER_USER) {
      const oldest = this.#streamedContent
        .keys()
        .find(
          (candidate) =>
            candidate !== view.selectedId && candidate !== view.detail?.id,
        );
      // Only the selected and rendered sessions are protected. The enforced
      // minimum cap guarantees an eviction candidate whenever this is over cap.
      if (oldest === undefined) break;
      this.#streamedContent.delete(oldest);
    }
  }

  #toolStreamAllowed(sessionId: string): boolean {
    const view = this.#view.value;
    return (
      !view.stopping &&
      view.selectedId === sessionId &&
      view.detail?.id === sessionId &&
      sessionDetailIsActive(view.detail)
    );
  }

  constructor(view: RevisionState<SessionViewState>) {
    this.#view = view;
  }

  #clearCompaction(sessionId: string): void {
    this.#compactionRequests.delete(sessionId);
    this.#streamedContent.delete(sessionId);
  }

  #sessionId(update: RealtimeStreamUpdate): string {
    return update.type === "tool_update"
      ? update.entry.sessionId
      : update.sessionId;
  }

  #forStreamSessions(
    event: RealtimeStreamBatch,
    apply: (sessionId: string) => void,
  ): void {
    for (const update of event.updates) apply(this.#sessionId(update));
  }

  #applyMutationStreamSessions(
    event: RealtimeStreamBatch,
    freeze: boolean,
  ): void {
    this.#forStreamSessions(event, (sessionId) => {
      if (freeze) this.#mutationRebases.add(sessionId);
      else this.#rebaseMutationStream(sessionId);
    });
  }

  freezeStreamBatch(event: RealtimeStreamBatch): void {
    this.#applyMutationStreamSessions(event, true);
  }

  rebaseStream(sessionId: string): void {
    this.#mutationRebases.add(sessionId);
  }

  #rebaseMutationStream(sessionId: string): void {
    if (!this.#mutationRebases.delete(sessionId)) return;
    this.#clearCompaction(sessionId);
    const view = this.#view.value;
    if (view.selectedId !== sessionId || view.detail?.id !== sessionId) return;
    const detail = persistedDetail(view.detail);
    const clearTools = view.toolStreams.length > 0;
    if (detail !== view.detail || clearTools) {
      this.#view.patch({
        ...(detail === view.detail ? {} : { detail }),
        ...(clearTools ? { toolStreams: [] } : {}),
      });
    }
  }

  applyReconnectDetail(detail: AgentSessionDetail): void {
    const current = this.#streamedContent.get(detail.id);
    const messages = persistedMessages(detail);
    const base =
      current?.baseMessageId === null
        ? messages.length === 0
        : messages.some(({ id }) => id === current?.baseMessageId);
    if (this.#compactionRequests.has(detail.id) && !base) {
      this.#clearCompaction(detail.id);
    }
    this.applyDetail(detail);
  }

  applyDetail(detail: AgentSessionDetail): void {
    this.#rebaseMutationStream(detail.id);
    const persistable = persistedDetail(detail);
    const active = sessionDetailIsActive(persistable);
    if (!active) {
      this.#clearCompaction(detail.id);
    }
    const clearToolStreams =
      !active &&
      this.#view.value.selectedId === detail.id &&
      this.#view.value.toolStreams.length > 0;
    const currentStream = this.#streamedContent.get(detail.id);
    const resolved =
      currentStream === undefined
        ? undefined
        : resolveStreamBase(persistable, currentStream);
    const streamed = resolved?.streamed;
    const reconciled = streamed
      ? reconcileStream(persistable, streamed)
      : { messages: persistable.messages, persisted: true };

    if (retainCompactionStream(currentStream, reconciled) && streamed) {
      this.#retainStreamedContent(detail.id, streamed);
    } else if (
      !retainCompactionStream(currentStream, reconciled) &&
      resolved?.provisional !== true
    ) {
      // A provisional suffix match keeps its unanchored buffer: dropping it
      // would lose a fresh stream's head when its first delta merely
      // collides with the end of persisted text. A retained stale buffer
      // can surface as a transient if a later snapshot advances past the
      // matched step; the next delta or a terminal status clears it.
      this.#streamedContent.delete(detail.id);
    }
    if (this.#view.value.selectedId !== detail.id) return;
    const current = this.#view.value.detail;
    const confirmedRequestIds = new Set(
      persistable.pendingInputs.map(({ clientRequestId }) => clientRequestId),
    );
    const retainedOptimisticInputs =
      this.#view.value.optimisticPendingInputs.filter(
        ({ clientRequestId }) => !confirmedRequestIds.has(clientRequestId),
      );
    const optimisticPendingInputs =
      retainedOptimisticInputs.length ===
      this.#view.value.optimisticPendingInputs.length
        ? this.#view.value.optimisticPendingInputs
        : retainedOptimisticInputs;
    const visibleDetail = retainUnchangedSessionData(current, {
      ...persistable,
      messages: reconciled.messages,
    });
    const detailUnchanged =
      current !== undefined && sessionDataMatches(current, visibleDetail);
    const optimisticUnchanged =
      optimisticPendingInputs === this.#view.value.optimisticPendingInputs;
    if (detailUnchanged && optimisticUnchanged && !clearToolStreams) return;

    this.#view.patch({
      ...(detailUnchanged ? {} : { detail: visibleDetail }),
      loadingDetail: false,
      optimisticPendingInputs,
      sessions: replaceSessionSummary(
        this.#view.value.sessions ?? [],
        persistable,
      ),
      ...(clearToolStreams ? { toolStreams: [] } : {}),
    });
  }

  applyCompaction(
    event: Extract<
      RealtimeServerEvent,
      { type: "session_compaction_request" | "session_compaction_settled" }
    >,
  ): void {
    if (event.type === "session_compaction_settled") {
      this.#clearCompaction(event.sessionId);
      const detail = this.#view.value.detail;
      if (
        this.#view.value.selectedId === event.sessionId &&
        detail?.id === event.sessionId
      ) {
        const persisted = persistedDetail(detail);
        if (persisted !== detail) this.#view.patch({ detail: persisted });
      }
      return;
    }
    const view = this.#view.value;
    const detail =
      view.selectedId === event.sessionId && view.detail?.id === event.sessionId
        ? view.detail
        : undefined;
    if (detail === undefined || !sessionDetailIsActive(detail) || view.stopping)
      return;
    const messages = persistedMessages(detail);
    const request = createDisplaySessionMessage({
      content: event.content,
      createdAt: detail.updatedAt,
      id: `stream:${event.streamId}:compaction-request`,
      role: "compaction_request",
    });
    this.#compactionRequests.set(event.sessionId, request);
    this.#retainStreamedContent(event.sessionId, {
      baseMessageId: messages.at(-1)?.id ?? null,
      compactionRequest: request,
      content: "",
      streamId: event.streamId,
      thinking: "",
    });
    this.#view.patch({
      detail: { ...detail, messages: [...messages, request] },
    });
  }
  applyStreamBatch(event: RealtimeStreamBatch): void {
    this.#applyMutationStreamSessions(event, false);
    const view = this.#view.value;
    let detail = view.detail;
    let streamedDetailChanged = false;
    let toolStreams = view.toolStreams;
    let toolStreamsChanged = false;
    for (const update of event.updates) {
      if (update.type === "tool_update") {
        if (
          view.stopping ||
          view.selectedId !== update.entry.sessionId ||
          detail?.id !== update.entry.sessionId ||
          !sessionDetailIsActive(detail)
        ) {
          continue;
        }
        const nextToolStreams = replaceToolStream(toolStreams, update);
        if (!toolStreamsMatch(toolStreams, nextToolStreams)) {
          toolStreams = nextToolStreams;
          toolStreamsChanged = true;
        }
        continue;
      }
      const delta = update;
      const selected = view.selectedId === delta.sessionId;
      const selectedDetail =
        selected && detail?.id === delta.sessionId
          ? persistedDetail(detail)
          : undefined;
      const visibleSelectedDetail =
        selected && detail?.id === delta.sessionId ? detail : undefined;
      const active =
        selectedDetail !== undefined && sessionDetailIsActive(selectedDetail);

      if (
        selectedDetail !== undefined &&
        (!sessionDetailIsActive(selectedDetail) || view.stopping)
      )
        continue;

      const initialDetail = active ? selectedDetail : undefined;
      const previous = this.#streamedContent.get(delta.sessionId);
      const next = streamedContent(
        previous,
        initialDetail,
        delta,
        this.#compactionRequests.get(delta.sessionId),
      );
      this.#retainStreamedContent(delta.sessionId, next);

      if (!active || !visibleSelectedDetail) continue;
      const visibleMessages = streamMessages(
        visibleSelectedDetail,
        next,
      ).messages;
      if (visibleMessages === visibleSelectedDetail.messages) continue;
      detail = { ...visibleSelectedDetail, messages: visibleMessages };
      streamedDetailChanged = true;
    }

    if (!streamedDetailChanged && !toolStreamsChanged) return;
    this.#view.patch({
      ...(streamedDetailChanged && detail !== undefined ? { detail } : {}),
      ...(toolStreamsChanged ? { toolStreams } : {}),
    });
  }
  applyToolSnapshot(
    event: Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }>,
  ): void {
    this.#rebaseMutationStream(event.sessionId);
    if (!this.#toolStreamAllowed(event.sessionId)) return;
    const current = new Map(
      this.#view.value.toolStreams
        .filter((entry) => entry.streamId === event.streamId)
        .map((entry) => [toolStreamKey(entry), entry]),
    );
    const streams = event.streams.map((entry) => {
      const local = current.get(toolStreamKey(entry));
      return local !== undefined && local.sequence >= entry.sequence
        ? local
        : entry;
    });
    const retained = this.#view.value.toolStreams.filter(
      (entry) => entry.streamId !== event.streamId,
    );
    const toolStreams = [...retained, ...streams];
    if (toolStreamsMatch(this.#view.value.toolStreams, toolStreams)) return;
    this.#view.patch({ toolStreams });
  }

  applySessions(sessions: readonly AgentSessionSummary[]): void {
    if (this.#view.value.sessions === undefined) return;
    if (sessionMutationPending(this.#view.value)) return;
    if (sessionSummariesMatch(this.#view.value.sessions, sessions)) return;

    this.#view.patch({ sessions });
  }

  reset(): void {
    this.#compactionRequests.clear();
    this.#mutationRebases.clear();
    this.#streamedContent.clear();
    if (this.#view.value.toolStreams.length > 0) {
      this.#view.patch({ toolStreams: [] });
    }
  }
}
