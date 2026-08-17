import { expect, test } from "vitest";
import type { RealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { RealtimeConnection } from "../../solid/realtime-client.ts";
import type { RealtimeClientEvent } from "../../solid/realtime-stream-buffer.ts";
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

function streamedEvents(
  events: readonly RealtimeClientEvent[],
): readonly RealtimeServerEvent[] {
  return events.flatMap((event) =>
    event.type === "stream_batch"
      ? event.updates.filter((update) => update.type !== "tool_update")
      : [],
  );
}

function latestStreamedEvent(
  events: readonly RealtimeClientEvent[],
): RealtimeServerEvent | undefined {
  return streamedEvents(events).at(-1);
}

test("coalesces session deltas while preserving reset and snapshot order", () => {
  const events: RealtimeClientEvent[] = [];
  const frames: (() => void)[] = [];
  const socket = new CoalescingSocket();
  const connection = new RealtimeConnection((event) => events.push(event), {
    clearTimeout: () => undefined,
    createSocket: () => socket,
    location: { href: "https://qmush.example/app", protocol: "https:" },
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    setTimeout: () => 1,
  });
  connection.start();
  socket.receive({ instanceId: "instance-1", type: "ready" });
  events.length = 0;

  socket.receive({
    content: "Hello",
    sessionId: "session-1",
    streamId: "stream-original",
    thinking: "Considering",
    type: "session_delta",
  });
  socket.receive({
    content: " world",
    sessionId: "session-1",
    streamId: "stream-original",
    thinking: " carefully",
    type: "session_delta",
  });
  socket.receive({ sessions: [], type: "sessions" });

  expect(events).toHaveLength(0);
  expect(frames).toHaveLength(2);
  frames[1]?.();
  expect(events.map(({ type }) => type)).toEqual(["sessions"]);

  socket.receive({
    content: "Replacement",
    reset: true,
    sessionId: "session-1",
    streamId: "stream-replacement",
    thinking: "Reconsidering",
    type: "session_delta",
  });
  socket.receive({
    content: " response",
    sessionId: "session-1",
    streamId: "stream-replacement",
    thinking: " from scratch",
    type: "session_delta",
  });
  frames[0]?.();
  expect(latestStreamedEvent(events)).toMatchObject({
    content: "Replacement response",
    reset: true,
    streamId: "stream-replacement",
    thinking: "Reconsidering from scratch",
  });

  socket.receive({
    content: "before snapshot",
    sessionId: TEST_SESSION_DETAIL.id,
    thinking: "",
    type: "session_delta",
  });
  socket.receive({
    content: "other",
    sessionId: "session-other",
    thinking: "",
    type: "session_delta",
  });
  socket.receive({ session: TEST_SESSION_DETAIL, type: "session" });
  expect(latestStreamedEvent(events)).toMatchObject({
    content: "before snapshot",
    sessionId: TEST_SESSION_DETAIL.id,
  });
  expect(frames).toHaveLength(4);
  frames[3]?.();
  expect(events.at(-1)).toEqual({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });
  frames[2]?.();
  expect(latestStreamedEvent(events)).toMatchObject({
    content: "other",
    sessionId: "session-other",
  });

  socket.receive({
    content: "fresh",
    sessionId: TEST_SESSION_DETAIL.id,
    thinking: "",
    type: "session_delta",
  });
  expect(frames).toHaveLength(5);
  frames[4]?.();
  expect(latestStreamedEvent(events)).toMatchObject({
    content: "fresh",
    thinking: "",
  });

  socket.receive({
    content: "discarded",
    sessionId: "session-2",
    thinking: "",
    type: "session_delta",
  });
  expect(frames).toHaveLength(6);
  connection.stop();
  frames[5]?.();
  expect(latestStreamedEvent(events)).toMatchObject({ content: "fresh" });
});
