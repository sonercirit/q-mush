import type { ProviderId } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import type { RevisionState } from "./revision-state.ts";
import type { SessionViewState } from "./session-client.tsx";
import { summaryFromDetail } from "./session-codec.ts";

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

export function retainUnchangedSessionData(
  current: AgentSessionDetail | undefined,
  detail: AgentSessionDetail,
): AgentSessionDetail {
  if (current?.id !== detail.id) {
    return detail;
  }

  const agentFile = serializedDataMatches(current.agentFile, detail.agentFile)
    ? current.agentFile
    : detail.agentFile;
  const messages = retainUnchangedMessages(current, detail.messages);
  return agentFile !== detail.agentFile ||
    messages.some((message, index) => message !== detail.messages[index])
    ? { ...detail, agentFile, messages }
    : detail;
}

function sessionMatches(
  view: RevisionState<SessionViewState>,
  sessionId: string,
): boolean {
  return view.value.selectedId === sessionId && view.value.detail !== undefined;
}

function sessionToolStreams(
  view: RevisionState<SessionViewState>,
  sessionId: string,
  streamId: string,
): readonly ToolStreamEntry[] {
  return view.value.toolStreams.filter(
    (stream) => stream.sessionId === sessionId && stream.streamId === streamId,
  );
}

interface StreamedSessionContent {
  readonly content: string;
  readonly streamId: string;
  readonly thinking: string;
}

function streamedMessageId(sessionId: string, role: string): string {
  return `stream:${sessionId}:${role}`;
}

function streamedMessages(
  detail: AgentSessionDetail,
  streamed: StreamedSessionContent,
): AgentSessionDetail["messages"] {
  const messages = [...detail.messages];
  const append = (role: "assistant" | "thinking", content: string): void => {
    if (content.length > 0) {
      messages.push({
        content,
        createdAt: detail.updatedAt,
        id: streamedMessageId(detail.id, role),
        images: [],
        role,
        toolCallId: null,
        toolCalls: [],
        toolName: null,
      });
    }
  };
  append("thinking", streamed.thinking);
  append("assistant", streamed.content);
  return messages;
}

export class SessionRealtimeState {
  readonly #streamedContent = new Map<string, StreamedSessionContent>();
  readonly #view: RevisionState<SessionViewState>;

  constructor(view: RevisionState<SessionViewState>) {
    this.#view = view;
  }

  applyDetail(detail: AgentSessionDetail): void {
    const persistable = this.#withoutStreamedMessages(detail);
    if (this.#view.value.selectedId !== detail.id) {
      return;
    }
    if (detail.status !== "queued" && detail.status !== "running") {
      const remaining = this.#view.value.toolStreams.filter(
        ({ sessionId }) => sessionId !== detail.id,
      );
      if (remaining.length !== this.#view.value.toolStreams.length) {
        this.#view.patch({ toolStreams: remaining });
      }
    }

    const current = this.#view.value.detail;
    const streamed = this.#streamedContent.get(detail.id);
    const sessionFinished =
      detail.status !== "queued" && detail.status !== "running";
    const streamIsPersisted =
      streamed !== undefined &&
      (sessionFinished || this.#streamIsPersisted(persistable, streamed));
    const visibleMessages =
      streamed === undefined || streamIsPersisted
        ? persistable.messages
        : streamedMessages(persistable, streamed);
    const visibleDetail = retainUnchangedSessionData(current, {
      ...persistable,
      messages: visibleMessages,
    });
    if (streamed !== undefined && streamIsPersisted) {
      this.#streamedContent.delete(detail.id);
    }
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

  #streamIsPersisted(
    detail: AgentSessionDetail,
    streamed: StreamedSessionContent,
  ): boolean {
    const recent = detail.messages.slice(-2);
    const persistedContent = recent.find(
      ({ role }) => role === "assistant",
    )?.content;
    const persistedThinking = recent.find(
      ({ role }) => role === "thinking",
    )?.content;
    return (
      (streamed.content.length === 0 ||
        persistedContent === streamed.content) &&
      (streamed.thinking.length === 0 ||
        persistedThinking === streamed.thinking)
    );
  }

  #withoutStreamedMessages(detail: AgentSessionDetail): AgentSessionDetail {
    return {
      ...detail,
      messages: detail.messages.filter(
        ({ id }) =>
          id !== streamedMessageId(detail.id, "thinking") &&
          id !== streamedMessageId(detail.id, "assistant"),
      ),
    };
  }

  applyDelta(
    event: Extract<RealtimeServerEvent, { type: "session_delta" }>,
  ): void {
    const current =
      !event.reset &&
      this.#streamedContent.get(event.sessionId)?.streamId === event.streamId
        ? this.#streamedContent.get(event.sessionId)
        : undefined;
    this.#streamedContent.set(event.sessionId, {
      content: (current?.content ?? "") + event.content,
      streamId: event.streamId,
      thinking: (current?.thinking ?? "") + event.thinking,
    });

    const detail = this.#view.value.detail;
    if (
      this.#view.value.selectedId !== event.sessionId ||
      detail === undefined
    ) {
      return;
    }

    const streamed = this.#streamedContent.get(event.sessionId);
    if (streamed === undefined) {
      return;
    }

    const visibleDetail = retainUnchangedSessionData(detail, {
      ...detail,
      messages: streamedMessages(
        this.#withoutStreamedMessages(detail),
        streamed,
      ),
    });
    this.#view.patch({ detail: visibleDetail });
  }

  applyToolDelta(
    event: Extract<RealtimeServerEvent, { type: "tool_stream" }>,
  ): void {
    if (!sessionMatches(this.#view, event.sessionId)) {
      return;
    }

    const local = sessionToolStreams(
      this.#view,
      event.sessionId,
      event.streamId,
    );
    const current = local.find(
      ({ callId, index }) =>
        callId === event.callId ||
        (index === event.index &&
          event.previousCallId !== undefined &&
          callId === event.previousCallId),
    );
    const otherStreams = this.#view.value.toolStreams.filter(
      ({ sessionId }) => sessionId !== event.sessionId,
    );
    const existing = current;
    const sequenceStart = event.sequenceStart ?? event.sequence;
    if (existing === undefined && sequenceStart !== 0) {
      return;
    }
    if (
      existing !== undefined &&
      event.previousCallId === undefined &&
      existing.callId !== event.callId
    ) {
      return;
    }
    if (
      existing !== undefined &&
      (sequenceStart <= existing.sequence ||
        sequenceStart > existing.sequence + 1)
    ) {
      return;
    }

    const created: ToolStreamEntry = existing ?? {
      arguments: "",
      callId: event.callId,
      index: event.index,
      name: "",
      sequence: -1,
      sessionId: event.sessionId,
      state: "preparing",
      stderr: "",
      stdout: "",
      streamId: event.streamId,
    };
    const content = event.content ?? "";
    const updated: ToolStreamEntry = {
      ...created,
      callId: event.callId,
      ...(event.channel === "arguments"
        ? { arguments: created.arguments + content }
        : event.channel === "name"
          ? { name: created.name + content }
          : event.channel === "stderr"
            ? { stderr: created.stderr + content }
            : event.channel === "stdout"
              ? { stdout: created.stdout + content }
              : {}),
      sequence: event.sequence,
      ...(event.state === undefined ? {} : { state: event.state }),
    };
    const toolStreams =
      existing === undefined
        ? [...local, updated]
        : local.map((entry) => (entry === existing ? updated : entry));
    this.#view.patch({ toolStreams: [...otherStreams, ...toolStreams] });
  }

  applyToolSnapshot(
    event: Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }>,
  ): void {
    const selected = this.#view.value.selectedId;
    const loaded = this.#view.value.detail;
    if (selected !== event.sessionId || loaded === undefined) {
      return;
    }
    const local = this.#view.value.toolStreams.filter(
      (stream) =>
        stream.sessionId === selected && stream.streamId === event.streamId,
    );
    const reconciled = event.streams.map((stream) => {
      const current = local.find(({ callId }) => callId === stream.callId);
      return current !== undefined && current.sequence > stream.sequence
        ? current
        : stream;
    });
    this.#view.patch({ toolStreams: reconciled });
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
    if (this.#view.value.toolStreams.length > 0) {
      this.#view.patch({ toolStreams: [] });
    }
  }
}
