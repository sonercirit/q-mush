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

// This cap accommodates both protected identities: the selected session and a
// separately rendered stale detail during navigation.
const MAXIMUM_STREAMED_SESSIONS_PER_USER = 100;

function orderedToolStreams(
  streams: readonly ToolStreamEntry[],
): readonly ToolStreamEntry[] {
  return [...streams].sort((left, right) => left.index - right.index);
}

function replaceToolStream(
  streams: readonly ToolStreamEntry[],
  update: RealtimeToolStreamUpdate,
): readonly ToolStreamEntry[] {
  const key = toolStreamKey(update.entry);
  const retained = streams.filter((entry) => toolStreamKey(entry) !== key);
  return update.terminal
    ? retained
    : orderedToolStreams([...retained, update.entry]);
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

type CompactionEvent = Extract<
  RealtimeServerEvent,
  { type: "session_compaction_request" | "session_compaction_settled" }
>;

export interface SessionRealtimeState {
  applyCompaction(event: CompactionEvent): void;
  applyDetail(detail: AgentSessionDetail): void;
  applyReconnectDetail(detail: AgentSessionDetail): void;
  applySessions(sessions: readonly AgentSessionSummary[]): void;
  applyStreamBatch(event: RealtimeStreamBatch): void;
  applyToolSnapshot(
    event: Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }>,
  ): void;
  freezeStreamBatch(event: RealtimeStreamBatch): void;
  rebaseStream(sessionId: string): void;
  reset(): void;
}

export function createSessionRealtimeState(
  revisionView: RevisionState<SessionViewState>,
): SessionRealtimeState {
  const compactionRequests = new Map<string, AgentSessionMessage>();
  const mutationRebases = new Set<string>();
  const streamedContents = new Map<string, StreamedSessionContent>();

  function oldestEvictableSession(ids: Iterable<string>): string | undefined {
    const view = revisionView.value;
    for (const candidate of ids) {
      if (candidate !== view.selectedId && candidate !== view.detail?.id) {
        return candidate;
      }
    }
    return undefined;
  }

  function retainMutationRebase(sessionId: string): void {
    mutationRebases.delete(sessionId);
    mutationRebases.add(sessionId);
    while (mutationRebases.size > MAXIMUM_STREAMED_SESSIONS_PER_USER) {
      const oldest = oldestEvictableSession(mutationRebases);
      // Only the selected and rendered sessions are protected, and the cap
      // accommodates both, so an eviction candidate exists when over cap.
      if (oldest === undefined) break;
      mutationRebases.delete(oldest);
    }
  }

  function retainStreamedContent(
    sessionId: string,
    content: StreamedSessionContent,
  ): void {
    streamedContents.delete(sessionId);
    streamedContents.set(sessionId, content);
    while (streamedContents.size > MAXIMUM_STREAMED_SESSIONS_PER_USER) {
      const oldest = oldestEvictableSession(streamedContents.keys());
      // Only the selected and rendered sessions are protected, and the cap
      // accommodates both, so an eviction candidate exists when over cap.
      if (oldest === undefined) break;
      streamedContents.delete(oldest);
    }
  }

  function toolStreamAllowed(sessionId: string): boolean {
    const view = revisionView.value;
    return (
      !view.stopping &&
      view.selectedId === sessionId &&
      view.detail?.id === sessionId &&
      sessionDetailIsActive(view.detail)
    );
  }

  function clearCompaction(sessionId: string): void {
    compactionRequests.delete(sessionId);
    streamedContents.delete(sessionId);
  }

  function sessionId(update: RealtimeStreamUpdate): string {
    return update.type === "tool_update"
      ? update.entry.sessionId
      : update.sessionId;
  }

  function forStreamSessions(
    event: RealtimeStreamBatch,
    apply: (sessionId: string) => void,
  ): void {
    for (const update of event.updates) apply(sessionId(update));
  }

  function applyMutationStreamSessions(
    event: RealtimeStreamBatch,
    freeze: boolean,
  ): void {
    forStreamSessions(event, (sessionId) => {
      if (freeze) retainMutationRebase(sessionId);
      else rebaseMutationStream(sessionId);
    });
  }

  function freezeStreamBatch(event: RealtimeStreamBatch): void {
    applyMutationStreamSessions(event, true);
  }

  function rebaseStream(sessionId: string): void {
    retainMutationRebase(sessionId);
  }

  function rebaseMutationStream(sessionId: string): void {
    if (!mutationRebases.delete(sessionId)) return;
    clearCompaction(sessionId);
    const view = revisionView.value;
    if (view.selectedId !== sessionId || view.detail?.id !== sessionId) return;
    const detail = persistedDetail(view.detail);
    const clearTools = view.toolStreams.length > 0;
    if (detail !== view.detail || clearTools) {
      revisionView.patch({
        ...(detail === view.detail ? {} : { detail }),
        ...(clearTools ? { toolStreams: [] } : {}),
      });
    }
  }

  function applyReconnectDetail(detail: AgentSessionDetail): void {
    const current = streamedContents.get(detail.id);
    const messages = persistedMessages(detail);
    const base =
      current?.baseMessageId === null
        ? messages.length === 0
        : messages.some(({ id }) => id === current?.baseMessageId);
    if (compactionRequests.has(detail.id) && !base) {
      clearCompaction(detail.id);
    }
    applyDetail(detail);
  }

  function applyDetail(detail: AgentSessionDetail): void {
    rebaseMutationStream(detail.id);
    const persistable = persistedDetail(detail);
    const active = sessionDetailIsActive(persistable);
    if (!active) {
      clearCompaction(detail.id);
    }
    const clearToolStreams =
      !active &&
      revisionView.value.selectedId === detail.id &&
      revisionView.value.toolStreams.length > 0;
    const currentStream = streamedContents.get(detail.id);
    const resolved =
      currentStream === undefined
        ? undefined
        : resolveStreamBase(persistable, currentStream);
    const streamed = resolved?.streamed;
    const reconciled = streamed
      ? reconcileStream(persistable, streamed)
      : { messages: persistable.messages, persisted: true };

    if (retainCompactionStream(currentStream, reconciled) && streamed) {
      retainStreamedContent(detail.id, streamed);
    } else if (
      !retainCompactionStream(currentStream, reconciled) &&
      resolved?.provisional !== true
    ) {
      // A provisional suffix match keeps its unanchored buffer: dropping it
      // would lose a fresh stream's head when its first delta merely
      // collides with the end of persisted text. A retained stale buffer
      // can surface as a transient if a later snapshot advances past the
      // matched step; the next delta or a terminal status clears it.
      streamedContents.delete(detail.id);
    }
    if (revisionView.value.selectedId !== detail.id) return;
    const current = revisionView.value.detail;
    const confirmedRequestIds = new Set(
      persistable.pendingInputs.map(({ clientRequestId }) => clientRequestId),
    );
    const retainedOptimisticInputs =
      revisionView.value.optimisticPendingInputs.filter(
        ({ clientRequestId }) => !confirmedRequestIds.has(clientRequestId),
      );
    const optimisticPendingInputs =
      retainedOptimisticInputs.length ===
      revisionView.value.optimisticPendingInputs.length
        ? revisionView.value.optimisticPendingInputs
        : retainedOptimisticInputs;
    const visibleDetail = retainUnchangedSessionData(current, {
      ...persistable,
      messages: reconciled.messages,
    });
    const detailUnchanged =
      current !== undefined && sessionDataMatches(current, visibleDetail);
    const optimisticUnchanged =
      optimisticPendingInputs === revisionView.value.optimisticPendingInputs;
    if (detailUnchanged && optimisticUnchanged && !clearToolStreams) return;

    revisionView.patch({
      ...(detailUnchanged ? {} : { detail: visibleDetail }),
      loadingDetail: false,
      optimisticPendingInputs,
      sessions: replaceSessionSummary(
        revisionView.value.sessions ?? [],
        persistable,
      ),
      ...(clearToolStreams ? { toolStreams: [] } : {}),
    });
  }

  function applyCompaction(event: CompactionEvent): void {
    if (event.type === "session_compaction_settled") {
      clearCompaction(event.sessionId);
      const detail = revisionView.value.detail;
      if (
        revisionView.value.selectedId === event.sessionId &&
        detail?.id === event.sessionId
      ) {
        const persisted = persistedDetail(detail);
        if (persisted !== detail) revisionView.patch({ detail: persisted });
      }
      return;
    }
    const view = revisionView.value;
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
    compactionRequests.set(event.sessionId, request);
    retainStreamedContent(event.sessionId, {
      baseMessageId: messages.at(-1)?.id ?? null,
      compactionRequest: request,
      content: "",
      streamId: event.streamId,
      thinking: "",
    });
    revisionView.patch({
      detail: { ...detail, messages: [...messages, request] },
    });
  }
  function applyStreamBatch(event: RealtimeStreamBatch): void {
    applyMutationStreamSessions(event, false);
    const view = revisionView.value;
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
      const previous = streamedContents.get(delta.sessionId);
      const next = streamedContent(
        previous,
        initialDetail,
        delta,
        compactionRequests.get(delta.sessionId),
      );
      retainStreamedContent(delta.sessionId, next);

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
    revisionView.patch({
      ...(streamedDetailChanged && detail !== undefined ? { detail } : {}),
      ...(toolStreamsChanged ? { toolStreams } : {}),
    });
  }
  function applyToolSnapshot(
    event: Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }>,
  ): void {
    rebaseMutationStream(event.sessionId);
    if (!toolStreamAllowed(event.sessionId)) return;
    const current = new Map(
      revisionView.value.toolStreams
        .filter((entry) => entry.streamId === event.streamId)
        .map((entry) => [toolStreamKey(entry), entry]),
    );
    const streams = event.streams.map((entry) => {
      const local = current.get(toolStreamKey(entry));
      return local !== undefined && local.sequence >= entry.sequence
        ? local
        : entry;
    });
    const retained = revisionView.value.toolStreams.filter(
      (entry) => entry.streamId !== event.streamId,
    );
    const toolStreams = orderedToolStreams([...retained, ...streams]);
    if (toolStreamsMatch(revisionView.value.toolStreams, toolStreams)) return;
    revisionView.patch({ toolStreams });
  }

  function applySessions(sessions: readonly AgentSessionSummary[]): void {
    if (revisionView.value.sessions === undefined) return;
    if (sessionMutationPending(revisionView.value)) return;
    if (sessionSummariesMatch(revisionView.value.sessions, sessions)) return;

    revisionView.patch({ sessions });
  }

  function reset(): void {
    compactionRequests.clear();
    mutationRebases.clear();
    streamedContents.clear();
    if (revisionView.value.toolStreams.length > 0) {
      revisionView.patch({ toolStreams: [] });
    }
  }

  return {
    applyCompaction,
    applyDetail,
    applyReconnectDetail,
    applySessions,
    applyStreamBatch,
    applyToolSnapshot,
    freezeStreamBatch,
    rebaseStream,
    reset,
  };
}
