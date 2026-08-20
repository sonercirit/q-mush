import { expect, test } from "vitest";
import {
  identifiedModelDelta,
  SESSION_ID,
  STREAM_ID,
} from "./realtime-stream-event-fixtures.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

test("keeps older deltas ahead of a later state barrier after terminal cleanup", () => {
  let clock = 0;
  const stream = streamingRealtimeFixture("terminal-barrier", undefined, {
    now: () => (clock += 5),
  });
  stream.receive({
    session: { ...TEST_SESSION_DETAIL, id: SESSION_ID, status: "completed" },
    type: "session",
  });
  stream.receive(identifiedModelDelta(SESSION_ID, STREAM_ID, "before-second"));
  const questions = {
    pending: null,
    sessionId: SESSION_ID,
    type: "session_questions" as const,
  };
  stream.receive(questions);
  const firstFrame = stream.pendingFrames.shift();
  expect(firstFrame).toBeDefined();
  firstFrame?.();
  expect(stream.emitted.length).toBe(1);
  expect(stream.emitted[0]?.type).toBe("session");

  stream.receive(
    identifiedModelDelta(SESSION_ID, "post-terminal", "after-terminal"),
  );
  do {
    stream.pendingFrames.shift()?.();
  } while (stream.pendingFrames.length !== 0);

  const deliveredTypes = stream.emitted.map((event) => event.type).join(",");
  expect(deliveredTypes).toBe(
    "session,stream_batch,session_questions,stream_batch",
  );
  expect(stream.emitted[1]).toMatchObject({
    updates: [{ content: "before-second" }],
  });
  stream.stop();
});
