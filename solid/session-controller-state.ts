import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { applyToolStreamDelta } from "../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import {
  isStreamedMessage,
  replaceSessionSummary,
  retainUnchangedSessionData,
  sessionDataMatches,
  sessionSummariesMatch,
  sortedMessages,
  streamedMessageId,
} from "./session-data-matching.ts";
import { createDisplaySessionMessage } from "./session-message.ts";
import { sessionMutationPending } from "./session-pending.ts";
import { toolStreamKey } from "./tool-stream-client.ts";

type StreamRole = "assistant" | "thinking";

interface StreamedSessionContent {
  readonly baseMessageId: string | null | undefined;
  readonly compactionRequest?: AgentSessionMessage;
  readonly content: string;
  readonly streamId: string | undefined;
  readonly thinking: string;
}

interface ReconciledStream {
  readonly messages: AgentSessionDetail["messages"];
  readonly persisted: boolean;
}

function persistedMessages(
  detail: AgentSessionDetail,
): AgentSessionDetail["messages"] {
  let streamStart = detail.messages.length;
  while (streamStart > 0) {
    const message = detail.messages[streamStart - 1];
    if (message === undefined || !isStreamedMessage(detail.id, message)) break;
    streamStart -= 1;
  }
  if (streamStart === detail.messages.length) return sortedMessages(detail);
  return detail.messages.slice(0, streamStart);
}

function persistedDetail(detail: AgentSessionDetail): AgentSessionDetail {
  const messages = persistedMessages(detail);
  return messages === detail.messages ? detail : { ...detail, messages };
}

function sessionIsActive(detail: AgentSessionDetail): boolean {
  return (
    detail.status === "queued" ||
    detail.status === "running" ||
    detail.status === "paused"
  );
}

// A buffered stream matches persisted text exactly or as its tail when the
// buffer missed leading deltas. Head or interior fragments never match: a
// fresh stream's first short delta often prefixes unrelated persisted text,
// and swallowing a fresh stream loses live output. A tail match short of
// equality is only weak evidence — a fresh delta can collide with the end
// of unrelated persisted text — so callers treat it as provisional.
type StreamBufferMatch = "exact" | "none" | "suffix";

function streamBufferMatch(
  persisted: string,
  buffered: string,
): StreamBufferMatch {
  if (buffered.length === 0) return "none";
  if (persisted === buffered) return "exact";
  return persisted.endsWith(buffered) ? "suffix" : "none";
}

interface PersistedStreamMatch {
  readonly exact: boolean;
  readonly index: number;
}

function persistedStreamStart(
  messages: AgentSessionDetail["messages"],
  streamed: StreamedSessionContent,
): PersistedStreamMatch | undefined {
  // Search only the final step run (its tool results, one assistant, and one
  // thinking message) for persisted content matching the buffered stream.
  // A content match is the evidence that this exact stream already
  // persisted; role presence alone would swallow fresh streams after
  // unrelated trailing assistants, and earlier steps' text must not match.
  let assistantIndex: number | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) return undefined;
    const role = message.role;
    if (role === "tool") continue;
    if (role === "assistant" && assistantIndex === undefined) {
      assistantIndex = index;
      if (streamed.thinking.length === 0) {
        const match = streamBufferMatch(message.content, streamed.content);
        if (match !== "none") return { exact: match === "exact", index };
      }
      continue;
    }
    if (role === "thinking" && streamed.thinking.length > 0) {
      const thinkingMatch = streamBufferMatch(
        message.content,
        streamed.thinking,
      );
      if (thinkingMatch === "none") return undefined;
      const exactThinking = thinkingMatch === "exact";
      if (streamed.content.length === 0) {
        return { exact: exactThinking, index };
      }
      const assistant =
        assistantIndex === undefined ? undefined : messages[assistantIndex];
      if (assistant === undefined) return undefined;
      const contentMatch = streamBufferMatch(
        assistant.content,
        streamed.content,
      );
      return contentMatch === "none"
        ? undefined
        : { exact: exactThinking && contentMatch === "exact", index };
    }
    return undefined;
  }
  return undefined;
}

interface ResolvedStreamBase {
  readonly provisional: boolean;
  readonly streamed: StreamedSessionContent;
}

function resolveStreamBase(
  detail: AgentSessionDetail,
  streamed: StreamedSessionContent,
): ResolvedStreamBase {
  if (streamed.baseMessageId !== undefined) {
    return { provisional: false, streamed };
  }
  // The stream began before this session's detail was available, so the
  // streamed step may already be persisted. Anchor before the persisted
  // messages whose content matches the stream so reconciliation recognizes
  // them as this stream's content; otherwise the stream is new and anchors
  // after the existing transcript. A compaction request skips content
  // matching: the request itself establishes a new transcript boundary, so
  // it always anchors after the transcript for reconciliation to append it
  // last. Suffix-only matches are provisional: the duplicate is suppressed
  // but the buffer must survive so a later delta re-evaluates the match.
  const match =
    streamed.compactionRequest !== undefined
      ? undefined
      : persistedStreamStart(detail.messages, streamed);
  const baseMessage =
    match === undefined
      ? detail.messages.at(-1)
      : detail.messages[match.index - 1];
  return {
    provisional: match !== undefined && !match.exact,
    streamed: { ...streamed, baseMessageId: baseMessage?.id ?? null },
  };
}

function streamStartIndex(
  messages: AgentSessionDetail["messages"],
  baseMessageId: StreamedSessionContent["baseMessageId"],
): number {
  if (baseMessageId === null) return 0;
  if (baseMessageId === undefined) return messages.length;
  const baseIndex = messages.findIndex(({ id }) => id === baseMessageId);
  return baseIndex < 0 ? messages.length : baseIndex + 1;
}

function matchingStreamMessageIndex(
  messages: AgentSessionDetail["messages"],
  startIndex: number,
  role: StreamRole,
): number {
  return messages.findIndex(
    (message, index) => index >= startIndex && message.role === role,
  );
}

function transientMessage(
  detail: AgentSessionDetail,
  role: StreamRole,
  content: string,
): AgentSessionMessage {
  return createDisplaySessionMessage({
    content,
    createdAt: detail.updatedAt,
    id: streamedMessageId(detail.id, role),
    role,
  });
}

function reconcileStream(
  detail: AgentSessionDetail,
  streamed: StreamedSessionContent,
): ReconciledStream {
  const messages = [...detail.messages];
  let startIndex = streamStartIndex(messages, streamed.baseMessageId);
  if (streamed.compactionRequest) {
    let requestIndex = messages.findIndex(
      ({ id }) => id === streamed.compactionRequest?.id,
    );
    if (requestIndex < 0) {
      messages.splice(startIndex, 0, streamed.compactionRequest);
      requestIndex = startIndex;
    }
    startIndex = requestIndex + 1;
  }
  const thinkingIndex = matchingStreamMessageIndex(
    messages,
    startIndex,
    "thinking",
  );
  const assistantIndex = matchingStreamMessageIndex(
    messages,
    startIndex,
    "assistant",
  );
  const thinkingPersisted =
    streamed.thinking.length === 0 || thinkingIndex >= 0;
  const assistantPersisted =
    streamed.content.length === 0 || assistantIndex >= 0;

  if (thinkingPersisted && assistantPersisted)
    return { messages, persisted: true };

  if (!thinkingPersisted && assistantPersisted) {
    messages.splice(
      assistantIndex < 0 ? startIndex : assistantIndex,
      0,
      transientMessage(detail, "thinking", streamed.thinking),
    );
  } else if (thinkingPersisted && !assistantPersisted) {
    messages.splice(
      thinkingIndex < 0 ? startIndex : thinkingIndex + 1,
      0,
      transientMessage(detail, "assistant", streamed.content),
    );
  } else {
    messages.splice(
      startIndex,
      0,
      transientMessage(detail, "thinking", streamed.thinking),
      transientMessage(detail, "assistant", streamed.content),
    );
  }

  return { messages, persisted: false };
}

function streamedMessage(
  detail: AgentSessionDetail,
  role: StreamRole,
): AgentSessionMessage | undefined {
  const message = detail.messages.at(role === "assistant" ? -1 : -2);
  return message?.id === streamedMessageId(detail.id, role)
    ? message
    : undefined;
}

function streamMessages(
  detail: AgentSessionDetail,
  streamed: StreamedSessionContent,
): ReconciledStream {
  const thinking = streamedMessage(detail, "thinking");
  const assistant = streamedMessage(detail, "assistant");
  const thinkingPersisted = streamed.thinking.length === 0;
  const assistantPersisted = streamed.content.length === 0;
  if (thinkingPersisted && assistantPersisted)
    return { messages: detail.messages, persisted: true };
  if (
    (thinkingPersisted || thinking?.content === streamed.thinking) &&
    (assistantPersisted || assistant?.content === streamed.content)
  ) {
    return { messages: detail.messages, persisted: false };
  }

  const messages = persistedMessages(detail);
  return {
    messages: [
      ...messages,
      ...(streamed.compactionRequest === undefined
        ? []
        : [streamed.compactionRequest]),
      ...(thinkingPersisted
        ? []
        : [
            thinking?.content === streamed.thinking
              ? thinking
              : transientMessage(detail, "thinking", streamed.thinking),
          ]),
      ...(assistantPersisted
        ? []
        : [
            assistant?.content === streamed.content
              ? assistant
              : transientMessage(detail, "assistant", streamed.content),
          ]),
    ],
    persisted: false,
  };
}

function retainCompactionStream(
  current: StreamedSessionContent | undefined,
  reconciled: ReconciledStream,
): boolean {
  return (
    current !== undefined &&
    (current.compactionRequest !== undefined || !reconciled.persisted)
  );
}

export class SessionRealtimeState {
  readonly #compactionRequests = new Map<string, AgentSessionMessage>();
  readonly #streamedContent = new Map<string, StreamedSessionContent>();
  readonly #view: RevisionState<SessionViewState>;

  constructor(view: RevisionState<SessionViewState>) {
    this.#view = view;
  }

  #clearCompaction(sessionId: string): void {
    this.#compactionRequests.delete(sessionId);
    this.#streamedContent.delete(sessionId);
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
    const persistable = persistedDetail(detail);
    const active = sessionIsActive(persistable);
    if (!active) {
      this.#clearCompaction(detail.id);
    }
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
      this.#streamedContent.set(detail.id, streamed);
    } else if (
      !retainCompactionStream(currentStream, reconciled) &&
      resolved?.provisional !== true
    ) {
      // A provisional suffix match keeps its unanchored buffer: dropping it
      // would lose a fresh stream's head when its first delta merely
      // collides with the end of persisted text.
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
    if (detailUnchanged && optimisticUnchanged) return;

    this.#view.patch({
      ...(detailUnchanged ? {} : { detail: visibleDetail }),
      loadingDetail: false,
      optimisticPendingInputs,
      sessions: replaceSessionSummary(
        this.#view.value.sessions ?? [],
        persistable,
      ),
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
    if (detail === undefined || !sessionIsActive(detail) || view.stopping)
      return;
    const messages = persistedMessages(detail);
    const request = createDisplaySessionMessage({
      content: event.content,
      createdAt: detail.updatedAt,
      id: `stream:${event.streamId}:compaction-request`,
      role: "compaction_request",
    });
    this.#compactionRequests.set(event.sessionId, request);
    this.#streamedContent.set(event.sessionId, {
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
  applyDelta(
    event: Extract<RealtimeServerEvent, { type: "session_delta" }>,
  ): void {
    const view = this.#view.value;
    const selected = view.selectedId === event.sessionId;
    const selectedDetail =
      selected && view.detail?.id === event.sessionId
        ? persistedDetail(view.detail)
        : undefined;
    const visibleSelectedDetail =
      selected && view.detail?.id === event.sessionId ? view.detail : undefined;
    const active =
      selectedDetail !== undefined && sessionIsActive(selectedDetail);

    if (
      selectedDetail !== undefined &&
      (!sessionIsActive(selectedDetail) || view.stopping)
    )
      return;

    const initialBase = active
      ? (selectedDetail.messages.at(-1)?.id ?? null)
      : undefined;
    const previous = this.#streamedContent.get(event.sessionId);
    const matchingPrevious =
      previous?.streamId === event.streamId ? previous : undefined;
    const current = event.reset ? undefined : matchingPrevious;
    const compactionRequest = this.#compactionRequests.get(event.sessionId);
    const next: StreamedSessionContent = {
      baseMessageId: current?.baseMessageId ?? initialBase,
      ...(compactionRequest === undefined ? {} : { compactionRequest }),
      content: (current?.content ?? "") + event.content,
      streamId: event.streamId,
      thinking: (current?.thinking ?? "") + event.thinking,
    };
    this.#streamedContent.set(event.sessionId, next);

    if (!active) return;
    if (!visibleSelectedDetail) return;
    const currentMessages = visibleSelectedDetail.messages;
    const visibleMessages = streamMessages(
      visibleSelectedDetail,
      next,
    ).messages;
    if (visibleMessages === currentMessages) return;
    this.#view.patch({
      detail: { ...visibleSelectedDetail, messages: visibleMessages },
    });
  }
  #selectedForToolStream(sessionId: string, requireDetail: boolean): boolean {
    return (
      this.#view.value.selectedId === sessionId &&
      (!requireDetail || this.#view.value.detail !== undefined)
    );
  }

  applyToolDelta(
    event: Extract<RealtimeServerEvent, { type: "tool_stream" }>,
  ): void {
    if (!this.#selectedForToolStream(event.sessionId, true)) return;
    const current = this.#view.value.toolStreams.find(
      (entry) => toolStreamKey(entry) === toolStreamKey(event),
    );
    const result = applyToolStreamDelta(current, event);
    if (!result.accepted) return;
    const retained = this.#view.value.toolStreams.filter(
      (entry) => toolStreamKey(entry) !== toolStreamKey(event),
    );
    this.#view.patch({
      toolStreams: result.terminal
        ? retained
        : [...retained, result.entry].sort(
            (left, right) => left.index - right.index,
          ),
    });
  }

  applyToolSnapshot(
    event: Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }>,
  ): void {
    if (!this.#selectedForToolStream(event.sessionId, false)) return;
    const current = new Map(
      this.#view.value.toolStreams.map((entry) => [
        toolStreamKey(entry),
        entry,
      ]),
    );
    const streams = event.streams.map((entry) => {
      const local = current.get(toolStreamKey(entry));
      return local !== undefined && local.sequence > entry.sequence
        ? local
        : entry;
    });
    this.#view.patch({ toolStreams: streams });
  }

  applySessions(sessions: readonly AgentSessionSummary[]): void {
    if (this.#view.value.sessions === undefined) return;
    if (sessionMutationPending(this.#view.value)) return;
    if (sessionSummariesMatch(this.#view.value.sessions, sessions)) return;

    this.#view.patch({ sessions });
  }

  reset(): void {
    this.#compactionRequests.clear();
    this.#streamedContent.clear();
    if (this.#view.value.toolStreams.length > 0) {
      this.#view.patch({ toolStreams: [] });
    }
  }
}
