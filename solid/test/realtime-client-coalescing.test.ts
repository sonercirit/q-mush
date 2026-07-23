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

test("coalesces session deltas into one update per animation frame", () => {
  const events: RealtimeServerEvent[] = [];
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

  for (const event of [
    {
      content: "Hello",
      sessionId: "session-1",
      thinking: "Considering",
      type: "session_delta",
    },
    {
      content: " world",
      sessionId: "session-1",
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
    thinking: "Reconsidering",
    type: "session_delta",
  });
  socket.receive({
    content: " response",
    sessionId: "session-1",
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
    thinking: "",
    type: "session_delta",
  });
  expect(frames).toHaveLength(2);
  connection.stop();
  frames[1]?.();
  expect(events).toHaveLength(4);
});
