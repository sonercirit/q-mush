import { createMemo, type Accessor } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";

export interface SessionTranscriptMessageGroups {
  readonly stable: readonly AgentSessionMessage[];
  readonly streamed: readonly AgentSessionMessage[];
}

function streamStart(messages: readonly AgentSessionMessage[]): number {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.id.startsWith("stream:") === true) {
    start -= 1;
  }
  return start;
}

export interface TranscriptNestedScrollKeys {
  readonly byMessageId: ReadonlyMap<string, string>;
  readonly nextByRole: ReadonlyMap<AgentSessionMessage["role"], string>;
}

export function transcriptNestedScrollKeys(
  messages: readonly AgentSessionMessage[],
): TranscriptNestedScrollKeys {
  const byMessageId = new Map<string, string>();
  let anchor: string | undefined;
  const roleOrdinals = new Map<AgentSessionMessage["role"], number>();
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "thinking") {
      const ordinal = roleOrdinals.get(message.role) ?? 0;
      byMessageId.set(
        message.id,
        anchor === undefined
          ? message.id
          : `after:${anchor}:${message.role}:${String(ordinal)}`,
      );
      roleOrdinals.set(message.role, ordinal + 1);
    } else {
      anchor = message.id;
      roleOrdinals.clear();
      byMessageId.set(message.id, message.id);
    }
  }
  return {
    byMessageId,
    nextByRole: new Map(
      (["assistant", "thinking"] as const).map((role) => {
        const ordinal = roleOrdinals.get(role) ?? 0;
        return [
          role,
          anchor === undefined
            ? role
            : `after:${anchor}:${role}:${String(ordinal)}`,
        ];
      }),
    ),
  };
}

export function createSessionTranscriptMessageGroups(
  messages: Accessor<readonly AgentSessionMessage[]>,
): Accessor<SessionTranscriptMessageGroups> {
  return createMemo((previous: SessionTranscriptMessageGroups | undefined) => {
    const current = messages();
    const start = streamStart(current);
    const hasStream = start < current.length;
    const stable =
      hasStream &&
      previous !== undefined &&
      previous.streamed.length > 0 &&
      previous.stable.length === start &&
      (start === 0 || previous.stable[start - 1] === current[start - 1])
        ? previous.stable
        : hasStream
          ? current.slice(0, start)
          : current;
    return { stable, streamed: current.slice(start) };
  });
}
