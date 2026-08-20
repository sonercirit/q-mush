import { expect, test } from "vitest";
import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../../shared/tool-stream.ts";
import { RealtimeStreamBuffer } from "../realtime-stream-buffer.ts";
import {
  activeToolDelta,
  deliverTerminalStream,
  identifiedModelDelta,
  orderedToolDelta,
  SESSION_ID,
  STREAM_ID,
} from "./realtime-stream-event-fixtures.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";

test("bounds pending keys before materialization", () => {
  const buffer = new RealtimeStreamBuffer();
  const total = MAXIMUM_TOOL_STREAMS_PER_USER + 1;
  for (let index = 0; index < total; index += 1) {
    buffer.queue(
      identifiedModelDelta(
        `pending-session-${String(index)}`,
        `pending-stream-${String(index)}`,
      ),
    );
  }

  let drained = 0;
  while (buffer.pending) {
    drained += buffer.takeNext(total)?.updates.length ?? 0;
  }
  expect(drained).toBe(MAXIMUM_TOOL_STREAMS_PER_USER);
});

test("compacts the oldest model stream instead of evicting it at the fragment cap", () => {
  const buffer = new RealtimeStreamBuffer();
  const oldestParts = ["oldest-first", "-oldest-second"];
  for (const part of oldestParts) {
    buffer.queue(identifiedModelDelta(SESSION_ID, STREAM_ID, part));
  }
  for (let index = 0; index < MAXIMUM_TOOL_STREAMS_PER_USER - 2; index += 1) {
    buffer.queue(
      identifiedModelDelta(
        `filler-session-${String(index)}`,
        `filler-stream-${String(index)}`,
      ),
    );
  }
  buffer.queue(identifiedModelDelta("new-session", "new-stream"));

  const content: string[] = [];
  while (buffer.pending) {
    for (const update of buffer.takeNext()?.updates ?? []) {
      if (update.type === "session_delta") content.push(update.content);
    }
  }
  expect(content).toContain(oldestParts.join(""));
});

test("retains compact terminal identity independent of rendered payload", () => {
  const buffer = new RealtimeStreamBuffer();
  const output = "x".repeat(64 * 1_024);
  deliverTerminalStream(
    buffer.queue.bind(buffer),
    0,
    STREAM_ID,
    undefined,
    output,
  );
  const terminal = buffer.takeNext()?.updates[0];
  if (terminal?.type !== "tool_update") {
    throw new TypeError("Missing terminal tool update");
  }
  Reflect.set(terminal.entry, "state", "running");
  buffer.queue(orderedToolDelta(4, { content: "late" }));

  expect(buffer.takeNext()).toBeUndefined();
});

function floodTerminalStreams(
  receive: Parameters<typeof deliverTerminalStream>[0],
  advance: () => void,
): void {
  for (let index = 0; index < MAXIMUM_TOOL_STREAMS_PER_SESSION; index += 1) {
    deliverTerminalStream(
      receive,
      index + 1,
      `terminal-step-${String(index)}`,
      undefined,
      undefined,
    );
    advance();
  }
}

test("active tool state survives a terminal tombstone flood", () => {
  const buffer = new RealtimeStreamBuffer();
  const activeStreamId = "active-stream";
  buffer.queue(activeToolDelta(activeStreamId));
  buffer.takeNext();

  floodTerminalStreams(buffer.queue.bind(buffer), () => {
    buffer.takeNext();
  });

  expect(buffer.activeToolStreams()).toContainEqual({
    sessionId: SESSION_ID,
    streamId: activeStreamId,
  });
});

test("reconnect synchronizes active tools retained through a tombstone flood", () => {
  const stream = streamingRealtimeFixture("tombstone-reconnect-instance");
  const activeStreamId = "surviving-active-stream";
  stream.receive(activeToolDelta(activeStreamId));
  stream.pendingFrames.shift()?.();

  floodTerminalStreams(stream.receive, () => {
    stream.pendingFrames.shift()?.();
  });
  const reconnected = stream.reconnect("tombstone-reconnected-instance");

  expect(reconnected.sent).toContain(
    JSON.stringify({
      sessionId: SESSION_ID,
      streamId: activeStreamId,
      type: "sync_tools",
    }),
  );
  stream.stop();
});

test("bounds terminal tombstones and permits evicted tool-key reuse", () => {
  const stream = streamingRealtimeFixture("terminal-cap-instance");
  const terminalCount = MAXIMUM_TOOL_STREAMS_PER_SESSION + 1;
  const terminalOutput = "x".repeat(32 * 1_024);
  for (let index = 0; index < terminalCount; index += 1) {
    const streamId = `terminal-step-${String(index)}`;
    deliverTerminalStream(
      stream.receive,
      index,
      streamId,
      undefined,
      terminalOutput,
    );
    stream.pendingFrames.shift()?.();
  }

  deliverTerminalStream(
    stream.receive,
    0,
    "terminal-step-0",
    "reused-call",
    undefined,
  );
  stream.pendingFrames.shift()?.();
  const batches = stream.emitted.filter(
    (event) => event.type === "stream_batch",
  );

  expect(batches).toHaveLength(terminalCount + 1);
  expect(batches.at(-1)?.updates[0]).toMatchObject({
    entry: { callId: "reused-call", sequence: 2, state: "completed" },
    terminal: true,
    type: "tool_update",
  });
  expect(stream.pendingFrames).toEqual([]);
  stream.stop();
});

test("retains an epoch while an overlapping barrier remains", () => {
  const buffer = new RealtimeStreamBuffer();
  const barriers = Array.from({ length: 2 }, () =>
    buffer.markBarrier(SESSION_ID),
  );

  const [first, second] = barriers;
  if (first === undefined || second === undefined)
    throw new Error("Missing barriers");
  buffer.releaseBarrier(first);

  const next = buffer.markBarrier(SESSION_ID);
  expect(next.epoch).toBe(2);
  for (const barrier of [second, next]) buffer.releaseBarrier(barrier);
});

test("reclaims an epoch only after its barriers and updates are gone", () => {
  const buffer = new RealtimeStreamBuffer();
  const first = buffer.markBarrier(SESSION_ID);
  buffer.queue(identifiedModelDelta(SESSION_ID, STREAM_ID));
  buffer.releaseBarrier(first);

  const overlapping = buffer.markBarrier(SESSION_ID);
  expect(overlapping.epoch).toBe(1);
  buffer.releaseBarrier(overlapping);
  buffer.takeNext();

  const reclaimed = buffer.markBarrier(SESSION_ID);
  expect(reclaimed.epoch).toBe(0);
});
