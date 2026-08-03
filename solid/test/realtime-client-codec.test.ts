import { expect, test } from "vitest";
import type { PendingAskQuestions } from "../../shared/ask-questions.ts";
import { readRealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function roundTrip(payload: Readonly<Record<string, unknown>>): unknown {
  return readRealtimeServerEvent(JSON.stringify(payload));
}

test("reads storage-health warnings", () => {
  const expected = {
    health: {
      degraded: true,
      reasons: ["database_corrupt", "disk_full", "low_disk_space"],
    },
    type: "health",
  } as const;
  expect(roundTrip(expected)).toEqual(expected);
  expect(() =>
    roundTrip({
      health: { degraded: true, reasons: ["unknown"] },
      type: "health",
    }),
  ).toThrow("invalid");
});

test("reads complete session snapshots from realtime messages", () => {
  expect(roundTrip({ session: TEST_SESSION_DETAIL, type: "session" })).toEqual({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });
});

test("reads pending question notifications", () => {
  const pending: PendingAskQuestions = {
    createdAt: 1,
    executionGeneration: 0,
    id: "request-1",
    questions: [
      {
        id: "decision",
        options: [
          { label: "Yes", value: "yes" },
          { label: "No", value: "no" },
        ],
        prompt: "Continue?",
        type: "single_choice",
      },
    ],
    toolCallId: "call-1",
  };
  expect(
    roundTrip({ pending, sessionId: "session-1", type: "session_questions" }),
  ).toEqual({ pending, sessionId: "session-1", type: "session_questions" });
  expect(
    roundTrip({
      pending: null,
      sessionId: "session-1",
      type: "session_questions",
    }),
  ).toEqual({
    pending: null,
    sessionId: "session-1",
    type: "session_questions",
  });
  expect(() =>
    roundTrip({
      pending: { ...pending, executionGeneration: -1 },
      sessionId: "session-1",
      type: "session_questions",
    }),
  ).toThrow("invalid pending questions");
});

test("reads runner snapshots from realtime messages", () => {
  expect(roundTrip({ runners: [runnerSummary(1)], type: "runners" })).toEqual({
    runners: [runnerSummary(1)],
    type: "runners",
  });
});

test("reads compaction requests from realtime messages", () => {
  const request = {
    content: "Compact the conversation.",
    sessionId: "session-1",
    streamId: "stream-1",
    type: "session_compaction_request",
  } as const;
  expect(roundTrip(request)).toEqual(request);
});

test("reads compaction settlement from realtime messages", () => {
  const settlement = {
    sessionId: "session-1",
    type: "session_compaction_settled",
  } as const;
  expect(roundTrip(settlement)).toEqual(settlement);
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
