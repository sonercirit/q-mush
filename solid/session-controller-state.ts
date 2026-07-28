import type { ProviderId } from "../shared/provider-credential-store.ts";
import { canonicalAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import { applyToolStreamDelta } from "../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { summaryFromDetail } from "./session-codec.ts";
import { createDisplaySessionMessage } from "./session-message.ts";
import { sessionMutationPending } from "./session-pending.ts";
import { toolStreamKey } from "./tool-stream-client.ts";

export function selectedSessionCredential(value: string):
  | {
      readonly credentialId: string;
      readonly provider: ProviderId;
    }
  | undefined {
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const credentialId = value.slice(separator + 1);

  if (
    separator < 1 ||
    (provider !== "openai" && provider !== "openrouter") ||
    credentialId.length === 0
  ) {
    return undefined;
  }

  return { credentialId, provider };
}

export function replaceSessionSummary(
  sessions: readonly AgentSessionSummary[],
  detail: AgentSessionDetail,
): readonly AgentSessionSummary[] {
  const summary = summaryFromDetail(detail);
  return [summary, ...sessions.filter(({ id }) => id !== summary.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
}

export function mergeNewerSelectedSessionSummary(
  sessions: readonly AgentSessionSummary[],
  selectedId: string | undefined,
  detail: AgentSessionDetail | undefined,
): readonly AgentSessionSummary[] {
  const selectedDetail = detail?.id === selectedId ? detail : undefined;
  const fetched = sessions.find(({ id }) => id === selectedId);
  return selectedDetail !== undefined &&
    fetched !== undefined &&
    selectedDetail.updatedAt > fetched.updatedAt
    ? replaceSessionSummary(sessions, selectedDetail)
    : sessions;
}

function serializedDataMatches(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function sessionDataMatches(
  left: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
  right: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
): boolean {
  return serializedDataMatches(left, right);
}

function canonicalSessionMessages(
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail["messages"] {
  return canonicalAgentSessionMessages(messages);
}

function retainUnchangedMessages(
  current: AgentSessionDetail,
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail["messages"] {
  const currentById = new Map(
    current.messages.map((message) => [message.id, message]),
  );
  return messages.map((message) => {
    const existing = currentById.get(message.id);
    return existing === message ||
      (existing !== undefined && serializedDataMatches(existing, message))
      ? existing
      : message;
  });
}

function sortedMessages(
  detail: AgentSessionDetail,
): AgentSessionDetail["messages"] {
  return detail.messages.some((message) =>
    isStreamedMessage(detail.id, message),
  )
    ? detail.messages
    : canonicalSessionMessages(detail.messages);
}

export function retainUnchangedSessionData(
  current: AgentSessionDetail | undefined,
  detail: AgentSessionDetail,
): AgentSessionDetail {
  const orderedMessages = sortedMessages(detail);
  if (current?.id !== detail.id) {
    return orderedMessages === detail.messages
      ? detail
      : { ...detail, messages: orderedMessages };
  }

  const agentFile = serializedDataMatches(current.agentFile, detail.agentFile)
    ? current.agentFile
    : detail.agentFile;
  const messages = retainUnchangedMessages(current, orderedMessages);
  return agentFile !== detail.agentFile ||
    messages.some((message, index) => message !== detail.messages[index])
    ? { ...detail, agentFile, messages }
    : detail;
}

type StreamRole = "assistant" | "thinking";

interface StreamedSessionContent {
  readonly baseMessageId: string | null | undefined;
  readonly content: string;
  readonly streamId: string | undefined;
  readonly thinking: string;
}

interface ReconciledStream {
  readonly messages: AgentSessionDetail["messages"];
  readonly persisted: boolean;
}

function streamedMessageId(sessionId: string, role: StreamRole): string {
  return `stream:${sessionId}:${role}`;
}

function isStreamedMessage(
  sessionId: string,
  message: AgentSessionMessage,
): boolean {
  return (
    message.id === streamedMessageId(sessionId, "thinking") ||
    message.id === streamedMessageId(sessionId, "assistant")
  );
}

function persistedMessages(
  detail: AgentSessionDetail,
): AgentSessionDetail["messages"] {
  return canonicalSessionMessages(
    detail.messages.filter((message) => !isStreamedMessage(detail.id, message)),
  );
}

function persistedDetail(detail: AgentSessionDetail): AgentSessionDetail {
  return { ...detail, messages: persistedMessages(detail) };
}

function sessionIsActive(detail: AgentSessionDetail): boolean {
  return (
    detail.status === "queued" ||
    detail.status === "running" ||
    detail.status === "paused"
  );
}

function resolveStreamBase(
  detail: AgentSessionDetail,
  streamed: StreamedSessionContent,
): StreamedSessionContent {
  return streamed.baseMessageId === undefined
    ? { ...streamed, baseMessageId: detail.messages.at(-1)?.id ?? null }
    : streamed;
}

function streamStartIndex(
  messages: AgentSessionDetail["messages"],
  baseMessageId: StreamedSessionContent["baseMessageId"],
): number {
  if (baseMessageId === null) {
    return 0;
  }
  if (baseMessageId === undefined) {
    return messages.length;
  }
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
  const startIndex = streamStartIndex(messages, streamed.baseMessageId);
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

  if (thinkingPersisted && assistantPersisted) {
    return { messages, persisted: true };
  }

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

export class SessionRealtimeState {
  readonly #streamedContent = new Map<string, StreamedSessionContent>();
  readonly #view: RevisionState<SessionViewState>;

  constructor(view: RevisionState<SessionViewState>) {
    this.#view = view;
  }

  applyDetail(detail: AgentSessionDetail): void {
    const persistable = persistedDetail(detail);
    if (!sessionIsActive(persistable)) {
      this.#streamedContent.delete(detail.id);
    }

    const currentStream = this.#streamedContent.get(detail.id);
    const streamed =
      currentStream === undefined
        ? undefined
        : resolveStreamBase(persistable, currentStream);
    const reconciled =
      streamed === undefined
        ? { messages: persistable.messages, persisted: true }
        : reconcileStream(persistable, streamed);

    if (streamed !== undefined) {
      if (reconciled.persisted) {
        this.#streamedContent.delete(detail.id);
      } else {
        this.#streamedContent.set(detail.id, streamed);
      }
    }

    if (this.#view.value.selectedId !== detail.id) {
      return;
    }

    const current = this.#view.value.detail;
    const visibleDetail = retainUnchangedSessionData(current, {
      ...persistable,
      messages: reconciled.messages,
    });
    if (current !== undefined && sessionDataMatches(current, visibleDetail)) {
      return;
    }

    this.#view.patch({
      detail: visibleDetail,
      loadingDetail: false,
      sessions: replaceSessionSummary(
        this.#view.value.sessions ?? [],
        persistable,
      ),
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
    const active =
      selectedDetail !== undefined && sessionIsActive(selectedDetail);

    if (
      selectedDetail !== undefined &&
      (!sessionIsActive(selectedDetail) || view.stopping)
    ) {
      return;
    }

    const initialBase = active
      ? (selectedDetail.messages.at(-1)?.id ?? null)
      : undefined;
    const current =
      !event.reset &&
      this.#streamedContent.get(event.sessionId)?.streamId === event.streamId
        ? this.#streamedContent.get(event.sessionId)
        : undefined;
    const next: StreamedSessionContent = {
      baseMessageId: current?.baseMessageId ?? initialBase,
      content: (current?.content ?? "") + event.content,
      streamId: event.streamId,
      thinking: (current?.thinking ?? "") + event.thinking,
    };
    this.#streamedContent.set(event.sessionId, next);

    if (!active) {
      return;
    }

    const currentMessages = view.detail?.messages ?? [];
    const visibleMessages = reconcileStream(selectedDetail, next).messages;
    const visibleDetail = retainUnchangedSessionData(view.detail, {
      ...selectedDetail,
      messages: visibleMessages.map((message) => {
        if (!isStreamedMessage(event.sessionId, message)) {
          return message;
        }
        const existing = currentMessages.find(({ id }) => id === message.id);
        return existing?.content !== message.content ? message : existing;
      }),
    });
    if (!sessionDataMatches(view.detail, visibleDetail)) {
      this.#view.patch({ detail: visibleDetail });
    }
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
    if (!this.#selectedForToolStream(event.sessionId, true)) {
      return;
    }
    const current = this.#view.value.toolStreams.find(
      (entry) => toolStreamKey(entry) === toolStreamKey(event),
    );
    const result = applyToolStreamDelta(current, event);
    if (!result.accepted) {
      return;
    }
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
    if (!this.#selectedForToolStream(event.sessionId, false)) {
      return;
    }
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
    if (
      this.#view.value.sessions === undefined ||
      sessionMutationPending(this.#view.value) ||
      sessionDataMatches(this.#view.value.sessions, sessions)
    ) {
      return;
    }

    this.#view.patch({ sessions });
  }

  reset(): void {
    this.#streamedContent.clear();
    if (this.#view.value.toolStreams.length > 0) {
      this.#view.patch({ toolStreams: [] });
    }
  }
}
