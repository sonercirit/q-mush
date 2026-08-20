import type { AgentSessionDetail } from "../../shared/session-model.ts";
import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { RealtimeStreamBatch } from "../realtime-stream-buffer.ts";

export const SESSION_ID = "session-ordered";
export const STREAM_ID = "stream-ordered";

export function preparingToolDelta(
  index: number,
  streamId: string,
  callId: string,
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  return {
    callId,
    index,
    sequence: 0,
    sessionId: SESSION_ID,
    state: "preparing",
    streamId,
    type: "tool_stream",
  };
}

export function activeToolDelta(
  streamId: string,
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  return preparingToolDelta(0, streamId, `active-${streamId}`);
}

export function modelOutputBatch(
  detail: AgentSessionDetail,
  content: string,
  streamId: string,
): RealtimeStreamBatch {
  return {
    type: "stream_batch",
    updates: [identifiedModelDelta(detail.id, streamId, content)],
  };
}

export function identifiedModelDelta(
  sessionId: string,
  streamId: string,
  content = streamId,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return {
    content,
    sessionId,
    streamId,
    thinking: "",
    type: "session_delta",
  };
}

export function orderedToolDelta(
  sequence: number,
  change:
    | { readonly state: "completed" | "preparing" | "running" }
    | { readonly content: string },
  callId = "ordered-call",
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  const identity = {
    callId,
    index: 0,
    sequence,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    type: "tool_stream" as const,
  };
  return "state" in change
    ? { ...identity, state: change.state }
    : { ...identity, channel: "stdout", content: change.content };
}

export function deliverTerminalStream(
  receive: (
    event: Extract<RealtimeServerEvent, { type: "tool_stream" }>,
  ) => void,
  index: number,
  streamId: string,
  callId: string | undefined,
  output: string | undefined,
): void {
  for (const event of terminalToolStream(index, streamId, callId, output)) {
    receive(event);
  }
}

function terminalToolStream(
  index: number,
  streamId: string,
  callId = `terminal-call-${String(index)}`,
  output?: string,
): readonly Extract<RealtimeServerEvent, { type: "tool_stream" }>[] {
  const identity = {
    callId,
    index,
    sessionId: SESSION_ID,
    streamId,
    type: "tool_stream" as const,
  };
  const running = [
    { ...identity, sequence: 0, state: "preparing" as const },
    { ...identity, sequence: 1, state: "running" as const },
  ];
  return output === undefined
    ? [...running, { ...identity, sequence: 2, state: "completed" as const }]
    : [
        ...running,
        {
          ...identity,
          channel: "stdout" as const,
          content: output,
          sequence: 2,
        },
        { ...identity, sequence: 3, state: "completed" as const },
      ];
}
