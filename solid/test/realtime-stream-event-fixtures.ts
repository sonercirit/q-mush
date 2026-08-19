import type { RealtimeServerEvent } from "../realtime-client-codec.ts";

const SESSION_ID = "session-ordered";
const STREAM_ID = "stream-ordered";

export function orderedToolDelta(
  sequence: number,
  change:
    | { readonly state: "completed" | "preparing" | "running" }
    | { readonly content: string },
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  const identity = {
    callId: "ordered-call",
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

export function terminalToolStream(
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
