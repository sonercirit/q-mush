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

test("rejects inconsistent pending question session snapshots", () => {
  /* jscpd:ignore-start */
  expect(() =>
    roundTrip({
      session: {
        ...TEST_SESSION_DETAIL,
        pendingQuestions: {
          createdAt: 1,
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
        },
      },
      type: "session",
    }),
  ).toThrow("invalid agent session");
  expect(() =>
    roundTrip({
      session: { ...TEST_SESSION_DETAIL, status: "waiting" },
      type: "session",
    }),
  ).toThrow("invalid agent session");
  expect(() =>
    roundTrip({
      session: {
        ...TEST_SESSION_DETAIL,
        activeStartedAt: 2,
        pendingQuestions: {
          createdAt: 1,
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
        },
        status: "waiting",
      },
      type: "session",
    }),
  ).toThrow("invalid agent session");
  /* jscpd:ignore-end */
});

test("reads runner snapshots from realtime messages", () => {
  expect(roundTrip({ runners: [runnerSummary(1)], type: "runners" })).toEqual({
    runners: [runnerSummary(1)],
    type: "runners",
  });
});

test("reads pending question notifications", () => {
  const event = {
    pending: {
      createdAt: 1,
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
    },
    sessionId: "session-1",
    type: "session_questions",
  } as const;
  expect(roundTrip(event)).toEqual(event);
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
