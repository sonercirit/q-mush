import { expect, test } from "vitest";
import { readRealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { testToolStreamEntry } from "./tool-stream-fixtures.ts";

function roundTrip(payload: Readonly<Record<string, unknown>>): unknown {
  return readRealtimeServerEvent(JSON.stringify(payload));
}

test("reads complete session snapshots from realtime messages", () => {
  expect(roundTrip({ session: TEST_SESSION_DETAIL, type: "session" })).toEqual({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });
});

test("reads runner snapshots from realtime messages", () => {
  expect(roundTrip({ runners: [runnerSummary(1)], type: "runners" })).toEqual({
    runners: [runnerSummary(1)],
    type: "runners",
  });
});

test("reads reset model deltas from realtime messages", () => {
  const delta = {
    content: "replacement",
    reset: true,
    sessionId: "session-1",
    streamId: "stream-1",
    thinking: "reconsidering",
    type: "session_delta",
  } as const;
  expect(roundTrip(delta)).toEqual(delta);
});

test("validates bounded tool stream events and snapshots", () => {
  const delta = {
    callId: "call-1",
    channel: "stdout",
    content: "hello",
    index: 0,
    sequence: 1,
    sessionId: "session-1",
    streamId: "turn-1",
    type: "tool_stream",
  } as const;
  expect(roundTrip(delta)).toEqual(delta);
  expect(roundTrip({ ...delta, sequenceStart: 0 })).toEqual({
    ...delta,
    sequenceStart: 0,
  });
  expect(() => roundTrip({ ...delta, sequenceStart: -1 })).toThrow("invalid");
  expect(() =>
    roundTrip({ ...delta, content: "x".repeat(32 * 1_024 + 1) }),
  ).toThrow("invalid");
  expect(
    roundTrip({
      sessionId: "session-1",
      streamId: "turn-1",
      streams: [testToolStreamEntry()],
      type: "tool_stream_snapshot",
    }),
  ).toMatchObject({ streams: [expect.objectContaining({ callId: "call-1" })] });
});

test("rejects invalid reset model deltas", () => {
  expect(() =>
    roundTrip({
      content: "replacement",
      reset: "true",
      sessionId: "session-1",
      streamId: "stream-1",
      thinking: "",
      type: "session_delta",
    }),
  ).toThrow("invalid");
});
