import { expect, test } from "vitest";
import {
  orderedToolDelta,
  preparingToolDelta,
} from "./realtime-stream-event-fixtures.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";

const SESSION_ID = "session-ordered";
const STREAM_ID = "stream-ordered";

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

test("does not resend unresolved session synchronization", () => {
  const stream = streamingRealtimeFixture("bounded-session-sync");
  stream.receive(preparingToolDelta(0, STREAM_ID, "bounded-call"));
  flushOne(stream);
  const socket = firstSocket(stream);
  socket.sent.length = 0;
  stream.setup.connection.syncTools(SESSION_ID);
  stream.setup.connection.syncTools(SESSION_ID);
  expect(socket.sent).toHaveLength(1);
  stream.stop();
});

test("retains current and remaining requests after a send failure", () => {
  const stream = streamingRealtimeFixture("failed-sync-instance");
  const failedStreams = ["failed-a", "failed-b"];
  for (const [index, streamId] of failedStreams.entries()) {
    const delta = preparingToolDelta(index, streamId, `call-${streamId}`);
    stream.receive(delta);
    stream.pendingFrames.shift()?.();
  }
  const socket = firstSocket(stream);
  socket.sent.length = 0;
  socket.throwAfter = 0;
  stream.setup.connection.syncTools(SESSION_ID);
  const reconnected = stream.reconnect("failed-sync-reconnected");
  const sentAfterFailure = reconnected.sent.length;
  expect(sentAfterFailure).toBe(2);
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
