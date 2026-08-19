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

test("resolves snapshot synchronization before terminal reconnect", () => {
  const stream = streamingRealtimeFixture("resolved-sync-instance");
  stream.receive(preparingToolDelta(0, STREAM_ID, "resolved-call"));
  stream.pendingFrames.shift()?.();
  const first = stream.reconnect("resolved-again");
  expectToolSync(first.sent);
  first.receive({
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    streams: [],
    type: "tool_stream_snapshot",
  });
  stream.pendingFrames.shift()?.();
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
    stream.receive(orderedToolDelta(0, { state: "preparing" }));
    stream.pendingFrames.shift()?.();
  }
  const socket = stream.setup.sockets.at(0);
  if (socket === undefined) throw new TypeError("Missing test socket");
  socket.sent.length = 0;
  stream.receive(delta);
  expectToolSync(socket.sent);
  stream.stop();
});
