import { expect, test } from "vitest";
import type { RealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import type { RealtimeClientEvent } from "../../solid/realtime-stream-buffer.ts";
import {
  realtimeEventRecorder,
  receiveRealtimeEvents,
  runNextRealtimeFrame,
  runningRealtimeEventRecorder,
  testSessionDelta,
} from "./realtime-client-coalescing-fixture.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

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

function expectLatestEvent(events: readonly RealtimeClientEvent[]) {
  return expect(events.at(-1));
}

function expectLatestDelta(events: readonly RealtimeClientEvent[]) {
  return expect(latestStreamedEvent(events));
}

test("keeps post-snapshot deltas behind a production-order session barrier", () => {
  const { running, stream } = runningRealtimeEventRecorder("barrier-instance");

  receiveRealtimeEvents(stream, [
    testSessionDelta("A", running.id, "barrier-stream"),
    { session: running, type: "session" },
    testSessionDelta("B", running.id, "barrier-stream"),
  ]);

  expect(stream.events).toEqual([]);
  const expectedFrames: readonly Readonly<Record<string, unknown>>[][] = [
    [],
    [{ type: "stream_batch", updates: [{ content: "A" }] }],
    [{ session: { id: running.id }, type: "session" }],
    [{ type: "stream_batch", updates: [{ content: "B" }] }],
  ];
  for (const expected of expectedFrames) {
    runNextRealtimeFrame(stream.setup.requestFrames);
    expect(stream.events.slice(-expected.length)).toMatchObject(expected);
  }
  stream.setup.connection.stop();
});

test("orders a replaced state key at its latest wire position", () => {
  const { running, stream } = runningRealtimeEventRecorder(
    "state-replacement-instance",
  );

  receiveRealtimeEvents(stream, [
    { session: running, type: "session" },
    {
      pending: null,
      sessionId: running.id,
      type: "session_questions",
    },
    {
      session: { ...running, updatedAt: running.updatedAt + 1 },
      type: "session",
    },
  ]);

  // One frame drains the whole deferred state queue in wire order.
  runNextRealtimeFrame(stream.setup.requestFrames);
  expect(stream.events).toMatchObject([
    { type: "session_questions" },
    { session: { updatedAt: running.updatedAt + 1 }, type: "session" },
  ]);
  expectLatestEvent(stream.events).toMatchObject({
    session: { updatedAt: running.updatedAt + 1 },
    type: "session",
  });
  stream.setup.connection.stop();
});

test("coalesces deltas while preserving reset, snapshot, and disconnect order", () => {
  const stream = realtimeEventRecorder("coalescing-instance");
  const frames = stream.setup.requestFrames;

  stream.receive(
    testSessionDelta("Hello", "session-1", "stream-original", "Considering"),
  );
  stream.receive(
    testSessionDelta(" world", "session-1", "stream-original", " carefully"),
  );
  runNextRealtimeFrame(frames);
  expectLatestDelta(stream.events).toMatchObject({
    thinking: "Considering carefully",
    content: "Hello world",
  });

  stream.receive({
    ...testSessionDelta(
      "Replacement",
      "session-1",
      "stream-replacement",
      "Reconsidering",
    ),
    reset: true,
  });
  stream.receive(
    testSessionDelta(
      " response",
      "session-1",
      "stream-replacement",
      " from scratch",
    ),
  );
  runNextRealtimeFrame(frames);
  expectLatestDelta(stream.events).toMatchObject({
    content: "Replacement response",
    reset: true,
    streamId: "stream-replacement",
    thinking: "Reconsidering from scratch",
  });

  stream.receive(testSessionDelta("before snapshot", TEST_SESSION_DETAIL.id));
  stream.receive(testSessionDelta("other", "session-other"));
  stream.receive({ session: TEST_SESSION_DETAIL, type: "session" });
  runNextRealtimeFrame(frames);
  runNextRealtimeFrame(frames);
  expectLatestEvent(stream.events).toMatchObject({
    type: "stream_batch",
    updates: [
      { content: "before snapshot", sessionId: TEST_SESSION_DETAIL.id },
    ],
  });
  runNextRealtimeFrame(frames);
  expectLatestEvent(stream.events).toMatchObject({
    session: TEST_SESSION_DETAIL,
    type: "session",
  });
  runNextRealtimeFrame(frames);
  expectLatestDelta(stream.events).toMatchObject({
    content: "other",
    sessionId: "session-other",
  });

  stream.receive(testSessionDelta("discarded", "session-2"));
  stream.setup.connection.stop();
  runNextRealtimeFrame(frames);
  expectLatestDelta(stream.events).toHaveProperty("content", "other");
});
