import { expect, test } from "bun:test";
import { readRealtimeServerEvent } from "../realtime-client-codec.ts";
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

test("reads incremental model deltas from realtime messages", () => {
  const delta = {
    content: "hello",
    sessionId: "session-1",
    thinking: "considering",
    type: "session_delta",
  } as const;
  expect(roundTrip(delta)).toEqual(delta);
});
