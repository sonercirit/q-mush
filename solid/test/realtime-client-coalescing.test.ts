import { expect, test } from "vitest";
import type { RealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { realtimeTestRig } from "./realtime-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function expectFramesAndLatest(
  events: readonly RealtimeServerEvent[],
  frames: readonly (() => void)[],
  frameCount: number,
  frameIndex: number,
  eventCount: number,
  expected: Readonly<Record<string, unknown>>,
): void {
  expect(frames).toHaveLength(frameCount);
  frames[frameIndex]?.();
  expect(events).toHaveLength(eventCount);
  expect(events.at(-1)).toMatchObject(expected);
}

test("coalesces session deltas into one update per animation frame", () => {
  const { connection, events, frames, socket } = realtimeTestRig();

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
  expect(events.at(-1)).toMatchObject(
    Object.fromEntries([
      ["content", "Replacement response"],
      ["reset", true],
      ["thinking", "Reconsidering from scratch"],
    ]),
  );

  socket.receive({
    content: "!",
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
  expect(frames).toHaveLength(2);
  socket.receive({ session: TEST_SESSION_DETAIL, type: "session" });
  expect(events.at(-2)).toMatchObject({ content: "!", thinking: "" });
  expect(events.at(-1)).toEqual({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });
  expectFramesAndLatest(events, frames, 3, 2, 5, {
    content: "other",
    sessionId: "session-other",
  });

  socket.receive({
    content: "fresh",
    sessionId: TEST_SESSION_DETAIL.id,
    thinking: "",
    type: "session_delta",
  });
  frames[1]?.();
  expectFramesAndLatest(events, frames, 4, 3, 6, {
    content: "fresh",
    thinking: "",
  });

  socket.receive({
    content: "discarded",
    sessionId: "session-2",
    thinking: "",
    type: "session_delta",
  });
  expect(frames).toHaveLength(5);
  connection.stop();
  frames[4]?.();
  expect(events).toHaveLength(6);
});
