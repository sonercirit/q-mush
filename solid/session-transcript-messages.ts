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

export function transcriptMessageNestedScrollKey(
  messages: readonly AgentSessionMessage[],
  message: AgentSessionMessage,
): string {
  if (message.role !== "assistant" && message.role !== "thinking") {
    return message.id;
  }
  const index = messages.indexOf(message);
  let anchor = index - 1;
  while (
    anchor >= 0 &&
    (messages[anchor]?.role === "assistant" ||
      messages[anchor]?.role === "thinking")
  ) {
    anchor -= 1;
  }
  const anchorMessage = messages[anchor];
  if (anchorMessage === undefined) return message.id;
  let ordinal = 0;
  for (let candidate = anchor + 1; candidate < index; candidate += 1) {
    if (messages[candidate]?.role === message.role) ordinal += 1;
  }
  return `after:${anchorMessage.id}:${message.role}:${String(ordinal)}`;
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
