import { expect, test, vi } from "vitest";
import { createToolSyncTracker } from "../realtime-client-tool-sync.ts";
import { createRealtimeStreamBuffer } from "../realtime-stream-buffer.ts";
import {
  orderedToolDelta,
  preparingToolDelta,
  SESSION_ID,
  STREAM_ID,
} from "./realtime-stream-event-fixtures.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function expectToolSync(sent: readonly string[] | undefined): void {
  const request = JSON.stringify({
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    type: "sync_tools",
  });
  expect(sent?.includes(request)).toBe(true);
}

function firstSocket(stream: ReturnType<typeof streamingRealtimeFixture>) {
  const socket = stream.setup.sockets.at(0);
  if (socket === undefined) throw new TypeError("Missing lifecycle socket");
  return socket;
}
function flushOne(stream: ReturnType<typeof streamingRealtimeFixture>): void {
  stream.pendingFrames.shift()?.();
}

test("reconnect deduplicates remembered, active, and resync tool streams", () => {
  const streamBuffer = createRealtimeStreamBuffer();
  const activeSpy = vi.spyOn(streamBuffer, "activeToolStreams");
  const resyncSpy = vi.spyOn(streamBuffer, "takeToolResyncRequests");
  const toolSync = createToolSyncTracker();
  const pendingSpy = vi.spyOn(toolSync, "pending");
  const stream = streamingRealtimeFixture("deduplicated-reconnect", undefined, {
    streamBuffer,
    toolSync,
  });
  const callId = "deduplicated-call";
  // Flushing the initial delta commits an active tool state.
  stream.receive(preparingToolDelta(0, STREAM_ID, callId));
  flushOne(stream);
  // A gap sends a synchronization request the tracker remembers.
  stream.receive(orderedToolDelta(2, { content: "sequence gap" }, callId));
  expectToolSync(firstSocket(stream).sent);
  // An unflushed delta becomes a resync request when the socket closes.
  stream.receive(orderedToolDelta(1, { state: "running" }, callId));

  const reconnected = stream.reconnect("deduplicated-again");
  const identity = { sessionId: SESSION_ID, streamId: STREAM_ID };
  const sourceRequests: Record<string, unknown> = {};
  for (const [source, spy] of Object.entries({
    active: activeSpy,
    pending: pendingSpy,
    resync: resyncSpy,
  })) {
    sourceRequests[source] = spy.mock.results.at(-1)?.value;
  }
  expect(sourceRequests).toEqual({
    active: [identity],
    pending: [identity],
    resync: [identity],
  });

  const identities = reconnected.sent.flatMap((frame) => {
    const parsed: unknown = JSON.parse(frame);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      parsed.type !== "sync_tools" ||
      !("sessionId" in parsed) ||
      typeof parsed.sessionId !== "string" ||
      !("streamId" in parsed) ||
      typeof parsed.streamId !== "string"
    ) {
      return [];
    }
    return [`${parsed.sessionId}:${parsed.streamId}`];
  });
  expect(identities).toEqual([`${SESSION_ID}:${STREAM_ID}`]);
  stream.stop();
});

test("does not resend unresolved session synchronization", () => {
  const stream = streamingRealtimeFixture("bounded-session-sync");
  stream.receive(preparingToolDelta(0, STREAM_ID, "bounded-call"));
  flushOne(stream);
  const socket = firstSocket(stream);
  socket.sent.length = 0;
  const state = {
    session: {
      ...TEST_SESSION_DETAIL,
      id: SESSION_ID,
      status: "running" as const,
    },
    type: "session" as const,
  };
  stream.receive(state);
  flushOne(stream);
  const firstCount = socket.sent.length;
  expect(firstCount).toBe(1);
  stream.receive(state);
  flushOne(stream);
  expect(socket.sent).toHaveLength(firstCount);
  stream.stop();
});

test("retains current and remaining requests after a send failure", () => {
  const toolSync = createToolSyncTracker();
  const stream = streamingRealtimeFixture("failed-sync-instance", undefined, {
    toolSync,
  });
  const failedStreams = ["failed-a", "failed-b"];
  for (const [index, streamId] of failedStreams.entries()) {
    stream.receive(preparingToolDelta(index, streamId, `call-${streamId}`));
    flushOne(stream);
  }
  const socket = firstSocket(stream);
  socket.sent.length = 0;
  socket.throwAfter = 0;
  stream.setup.connection.syncTools(SESSION_ID);
  const pendingSpy = vi.spyOn(toolSync, "pending");
  stream.reconnect("failed-sync-reconnected");
  expect(pendingSpy.mock.results.at(-1)?.value).toEqual(
    failedStreams.map((streamId) => ({ sessionId: SESSION_ID, streamId })),
  );
  stream.stop();
});

test("delivers and resolves concurrent stream snapshots independently", () => {
  const stream = streamingRealtimeFixture("concurrent-sync-instance");
  const [flushedId, pendingId] = ["flushed", "pending"] as const;
  const streamIds = [flushedId, pendingId];
  stream.receive(preparingToolDelta(0, flushedId, "call-flushed"));
  flushOne(stream);
  stream.receive(preparingToolDelta(1, pendingId, "call-pending"));
  flushOne(stream);
  const reconnected = stream.reconnect("concurrent-sync-reconnected");
  for (const streamId of streamIds) {
    reconnected.receive({
      sessionId: SESSION_ID,
      streamId,
      streams: [],
      type: "tool_stream_snapshot",
    });
  }
  while (stream.pendingFrames.length > 0) flushOne(stream);

  expect(
    stream.emitted.flatMap((event) =>
      event.type === "tool_stream_snapshot" ? [event.streamId] : [],
    ),
  ).toEqual(streamIds);
  expect(stream.reconnect("concurrent-sync-terminal").sent).toHaveLength(0);
  stream.stop();
});

test("resolves snapshot synchronization before terminal reconnect", () => {
  const stream = streamingRealtimeFixture("resolved-sync-instance");
  stream.receive(preparingToolDelta(0, STREAM_ID, "resolved-call"));
  flushOne(stream);
  const first = stream.reconnect("resolved-again");
  expectToolSync(first.sent);
  first.receive({
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    streams: [],
    type: "tool_stream_snapshot",
  });
  flushOne(stream);
  const terminal = stream.reconnect("terminal-again");
  expect(terminal.sent).toHaveLength(0);
  stream.stop();
});

test.each([
  ["missing initial", orderedToolDelta(1, { content: "late" })],
  ["sequence gap", orderedToolDelta(2, { content: "gap" })],
])("requests a snapshot for a %s tool delta", (_name, delta) => {
  const stream = streamingRealtimeFixture("reject-instance");
  if (delta.sequence > 1) {
    const initial = orderedToolDelta(0, { state: "preparing" });
    stream.receive(initial);
    const applyInitialFrame = stream.pendingFrames.shift();
    applyInitialFrame?.();
  }
  const socket = firstSocket(stream);
  socket.sent.splice(0);
  stream.receive(delta);
  expectToolSync(socket.sent);
  stream.stop();
});
