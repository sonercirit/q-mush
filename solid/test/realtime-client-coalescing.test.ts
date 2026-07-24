import { expect, test } from "vitest";
import type { RealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { RealtimeConnection } from "../../solid/realtime-client.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

class CoalescingSocket extends EventTarget {
  get readyState(): number {
    return WebSocket.OPEN;
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(): void {
    // No client messages are relevant to delta coalescing.
  }

  receive(event: unknown): void {
    const message = new MessageEvent("message");
    Object.defineProperty(message, "data", { value: JSON.stringify(event) });
    this.dispatchEvent(message);
  }
}

function createCoalescingConnection(
  events: RealtimeServerEvent[],
  frames: (() => void)[],
): {
  readonly connection: RealtimeConnection;
  readonly socket: CoalescingSocket;
} {
  const socket = new CoalescingSocket();
  const connection = new RealtimeConnection((event) => events.push(event), {
    clearTimeout: () => undefined,
    createSocket: () => socket,
    location: { href: "https://qmush.example/app", protocol: "https:" },
    requestFrame: (callback) => frames.push(callback),
    setTimeout: () => 1,
  });
  connection.start();
  return { connection, socket };
}

function createCoalescingState(): {
  readonly connection: RealtimeConnection;
  readonly events: RealtimeServerEvent[];
  readonly frames: (() => void)[];
  readonly socket: CoalescingSocket;
} {
  const events: RealtimeServerEvent[] = [];
  const frames: (() => void)[] = [];
  return { ...createCoalescingConnection(events, frames), events, frames };
}

function toolStreamDelta(
  sequence: number,
  overrides: Partial<
    Extract<RealtimeServerEvent, { readonly type: "tool_stream" }>
  > = {},
): Extract<RealtimeServerEvent, { readonly type: "tool_stream" }> {
  return {
    callId: "call-1",
    channel: "stdout",
    content: String(sequence),
    index: 0,
    sequence,
    sessionId: "session-1",
    streamId: "turn-1",
    type: "tool_stream",
    ...overrides,
  };
}

function expectEvents(
  events: readonly RealtimeServerEvent[],
  expected: readonly unknown[],
): void {
  expect(events).toMatchObject(expected);
}

test("coalesces adjacent tool fragments without crossing calls or states", () => {
  const state = createCoalescingState();
  const { connection, events, frames, socket } = state;

  socket.receive(toolStreamDelta(0, { content: "one" }));
  socket.receive(toolStreamDelta(1, { content: " two" }));
  socket.receive(toolStreamDelta(2, { state: "completed" }));
  socket.receive(
    toolStreamDelta(0, {
      callId: "call-2",
      channel: "stderr",
      content: "other",
      index: 1,
    }),
  );
  frames[0]?.();

  expectEvents(events, [
    {
      callId: "call-1",
      content: "one two",
      sequence: 1,
      sequenceStart: 0,
    },
    { callId: "call-1", sequence: 2, state: "completed" },
    { callId: "call-2", content: "other", sequence: 0 },
  ]);
  connection.stop();
});

test("coalesces session deltas into one update per animation frame", () => {
  const { connection, events, frames, socket } = createCoalescingState();

  for (const event of [
    {
      content: "Hello",
      sessionId: "session-1",
      streamId: "stream-1",
      thinking: "Considering",
      type: "session_delta",
    },
    {
      content: " world",
      sessionId: "session-1",
      streamId: "stream-1",
      thinking: " carefully",
      type: "session_delta",
    },
  ] as const) {
    socket.receive(event);
  }
  socket.receive({ sessions: [], type: "sessions" });

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("sessions");
  expect(frames).toHaveLength(1);
  socket.receive({
    content: "Replacement",
    reset: true,
    sessionId: "session-1",
    streamId: "stream-1",
    thinking: "Reconsidering",
    type: "session_delta",
  });
  socket.receive({
    content: " response",
    sessionId: "session-1",
    streamId: "stream-1",
    thinking: " from scratch",
    type: "session_delta",
  });
  frames[0]?.();
  expect(events.at(-1)).toMatchObject({
    content: "Replacement response",
    reset: true,
    thinking: "Reconsidering from scratch",
  });

  socket.receive({
    content: "!",
    sessionId: TEST_SESSION_DETAIL.id,
    streamId: "stream-1",
    thinking: "",
    type: "session_delta",
  });
  socket.receive({ session: TEST_SESSION_DETAIL, type: "session" });
  expect(events.at(-2)).toMatchObject({ content: "!", thinking: "" });
  expect(events.at(-1)).toEqual({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });

  socket.receive({
    content: "discarded",
    sessionId: "session-2",
    streamId: "stream-1",
    thinking: "",
    type: "session_delta",
  });
  expect(frames).toHaveLength(2);
  connection.stop();
  frames[1]?.();
  expect(events).toHaveLength(4);
});
