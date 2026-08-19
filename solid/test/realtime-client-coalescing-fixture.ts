import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { RealtimeClientEvent } from "../realtime-stream-buffer.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";

export interface RealtimeEventRecorder {
  readonly events: RealtimeClientEvent[];
  readonly setup: ReturnType<typeof realtimeTestSetup>;
  receive(event: RealtimeServerEvent): void;
}

export function realtimeEventRecorder(
  instanceId: string,
): RealtimeEventRecorder {
  const events: RealtimeClientEvent[] = [];
  const setup = realtimeTestSetup({
    listener(event) {
      events.push(event);
    },
  });
  const [socket] = setup.sockets;
  if (socket === undefined) throw new TypeError("Realtime socket was not made");
  socket.open(instanceId);
  events.length = 0;
  return {
    events,
    receive: (event) => {
      socket.receive(event);
    },
    setup,
  };
}

export function runNextRealtimeFrame(frames: (() => void)[]): void {
  const frame = frames.shift();
  if (frame === undefined) throw new TypeError("Missing realtime frame");
  frame();
}

export function testSessionDelta(
  content: string,
  sessionId: string,
  streamId?: string,
  thinking = "",
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  const value: Extract<RealtimeServerEvent, { type: "session_delta" }> = {
    content,
    sessionId,
    thinking,
    type: "session_delta",
  };
  return streamId === undefined ? value : { ...value, streamId };
}
