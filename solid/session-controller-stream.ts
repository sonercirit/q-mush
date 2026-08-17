import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../shared/session-model.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";
import {
  isStreamedMessage,
  sortedMessages,
  streamedMessageId,
} from "./session-data-matching.ts";
import { createDisplaySessionMessage } from "./session-message.ts";

type StreamRole = "assistant" | "thinking";

export interface StreamedSessionContent {
  readonly baseMessageId: string | null | undefined;
  readonly compactionRequest?: AgentSessionMessage;
  readonly content: string;
  readonly streamId: string | undefined;
  readonly thinking: string;
}

export interface ReconciledStream {
  readonly messages: AgentSessionDetail["messages"];
  readonly persisted: boolean;
}

export function persistedMessages(
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

export function persistedDetail(
  detail: AgentSessionDetail,
): AgentSessionDetail {
  const messages = persistedMessages(detail);
  return messages === detail.messages ? detail : { ...detail, messages };
}

export function sessionIsActive(detail: AgentSessionDetail): boolean {
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
// of unrelated persisted text — so callers treat it as provisional. An
// exact match is strong evidence but not proof: a fresh first delta equal
// to the persisted text verbatim still drops, an accepted rarity.
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

export interface ResolvedStreamBase {
  readonly provisional: boolean;
  readonly streamed: StreamedSessionContent;
}

export function resolveStreamBase(
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

export function reconcileStream(
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

export function streamMessages(
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

export function retainCompactionStream(
  current: StreamedSessionContent | undefined,
  reconciled: ReconciledStream,
): boolean {
  return (
    current !== undefined &&
    (current.compactionRequest !== undefined || !reconciled.persisted)
  );
}

export function streamedContent(
  previous: StreamedSessionContent | undefined,
  detail: AgentSessionDetail | undefined,
  event: Extract<RealtimeServerEvent, { type: "session_delta" }>,
  compactionRequest: AgentSessionMessage | undefined,
): StreamedSessionContent {
  const matchingPrevious =
    previous?.streamId === event.streamId ? previous : undefined;
  const current = event.reset ? undefined : matchingPrevious;
  return {
    baseMessageId:
      current?.baseMessageId ??
      (detail === undefined ? undefined : (detail.messages.at(-1)?.id ?? null)),
    ...(compactionRequest === undefined ? {} : { compactionRequest }),
    content: (current?.content ?? "") + event.content,
    streamId: event.streamId,
    thinking: (current?.thinking ?? "") + event.thinking,
  };
}
