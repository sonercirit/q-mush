import type { ProviderId } from "../shared/provider-credential-store.ts";
import type { ProviderLimitState } from "../shared/provider-limits.ts";
import { canonicalAgentSessionMessages } from "../shared/session-message-order.ts";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { summaryFromDetail } from "./session-codec.ts";
import { createDisplaySessionMessage } from "./session-message.ts";

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
  return detail.status === "queued" || detail.status === "running";
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
  content: string,
): number {
  return content.length === 0
    ? -1
    : messages.findIndex(
        (message, index) =>
          index >= startIndex &&
          message.role === role &&
          message.content === content,
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
    streamed.thinking,
  );
  const assistantIndex = matchingStreamMessageIndex(
    messages,
    startIndex,
    "assistant",
    streamed.content,
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
    const current = event.reset
      ? {
          baseMessageId: initialBase,
          content: "",
          thinking: "",
        }
      : (this.#streamedContent.get(event.sessionId) ?? {
          baseMessageId: initialBase,
          content: "",
          thinking: "",
        });
    const next: StreamedSessionContent = {
      baseMessageId: current.baseMessageId,
      content: current.content + event.content,
      thinking: current.thinking + event.thinking,
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

  applyProviderLimits(credentialId: string, limits: ProviderLimitState): void {
    const currentSessions = this.#view.value.sessions;
    const matchingSessions = currentSessions?.filter(
      (session) =>
        session.credentialId === credentialId &&
        session.providerLimits !== limits,
    );
    const sessions =
      matchingSessions === undefined || matchingSessions.length === 0
        ? undefined
        : currentSessions?.map((session) =>
            session.credentialId === credentialId
              ? { ...session, providerLimits: limits }
              : session,
          );
    const detail = this.#view.value.detail;
    const updatedDetail =
      detail?.credentialId === credentialId && detail.providerLimits !== limits
        ? { ...detail, providerLimits: limits }
        : undefined;
    if (sessions === undefined && updatedDetail === undefined) {
      return;
    }
    this.#view.patch({
      ...(sessions === undefined ? {} : { sessions }),
      ...(updatedDetail === undefined ? {} : { detail: updatedDetail }),
    });
  }

  applySessions(sessions: readonly AgentSessionSummary[]): void {
    if (
      this.#view.value.sessions === undefined ||
      this.#view.value.compacting ||
      this.#view.value.creating ||
      this.#view.value.sending ||
      this.#view.value.stopping ||
      sessionDataMatches(this.#view.value.sessions, sessions)
    ) {
      return;
    }

    this.#view.patch({ sessions });
  }

  reset(): void {
    this.#streamedContent.clear();
  }
}
