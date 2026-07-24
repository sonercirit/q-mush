import { expect, test } from "vitest";
import { readRealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

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

test("reads bounded compaction lifecycle events", () => {
  const start = {
    attempt: 0,
    operationId: "operation-1",
    phase: "start",
    sequence: 0,
    sessionId: "session-1",
    type: "session_compaction",
  } as const;
  const delta = {
    ...start,
    phase: "delta",
    reasoning: "reasoning",
    sequence: 1,
    summary: "summary",
  } as const;

  expect(roundTrip(start)).toEqual(start);
  expect(roundTrip(delta)).toEqual(delta);
  expect(() => roundTrip({ ...delta, sequence: -1 })).toThrow("invalid");
});

test("reads reset model deltas from realtime messages", () => {
  const delta = {
    content: "replacement",
    reset: true,
    sessionId: "session-1",
    thinking: "reconsidering",
    type: "session_delta",
  } as const;
  expect(roundTrip(delta)).toEqual(delta);
});

test("rejects invalid reset model deltas", () => {
  expect(() =>
    roundTrip({
      content: "replacement",
      reset: "true",
      sessionId: "session-1",
      thinking: "",
      type: "session_delta",
    }),
  ).toThrow("invalid");
});
