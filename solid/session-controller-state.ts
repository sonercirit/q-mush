import type { ProviderId } from "../shared/provider-credential-store.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../shared/session-model.ts";
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

export function sessionDataMatches(
  left: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
  right: AgentSessionDetail | readonly AgentSessionSummary[] | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface StreamedSessionContent {
  readonly content: string;
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

    const current = this.#view.value.detail;
    const streamed = this.#streamedContent.get(detail.id);
    const streamIsPersisted =
      streamed !== undefined && this.#streamIsPersisted(persistable, streamed);
    const visibleDetail =
      streamed === undefined || streamIsPersisted
        ? persistable
        : {
            ...persistable,
            messages: streamedMessages(persistable, streamed),
          };
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
    const current = this.#streamedContent.get(event.sessionId) ?? {
      content: "",
      thinking: "",
    };
    this.#streamedContent.set(event.sessionId, {
      content: current.content + event.content,
      thinking: current.thinking + event.thinking,
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

    this.#view.patch({
      detail: {
        ...detail,
        messages: streamedMessages(
          this.#withoutStreamedMessages(detail),
          streamed,
        ),
      },
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
