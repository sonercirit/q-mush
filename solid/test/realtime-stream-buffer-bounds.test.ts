import { expect, test } from "vitest";
import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../../shared/tool-stream.ts";
import {
  createRealtimeStreamBuffer,
  type RealtimeStreamBatch,
  type RealtimeStreamBuffer,
} from "../realtime-stream-buffer.ts";
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
  const buffer = createRealtimeStreamBuffer();
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

function drainUpdates(
  buffer: RealtimeStreamBuffer,
): RealtimeStreamBatch["updates"] {
  const updates: RealtimeStreamBatch["updates"][number][] = [];
  while (buffer.pending) updates.push(...(buffer.takeNext()?.updates ?? []));
  return updates;
}

function queueModelParts(
  buffer: RealtimeStreamBuffer,
  parts: readonly string[],
): void {
  for (const part of parts)
    buffer.queue(identifiedModelDelta(SESSION_ID, STREAM_ID, part));
}

function modelContents(buffer: RealtimeStreamBuffer): readonly string[] {
  return drainUpdates(buffer)
    .filter((update) => update.type === "session_delta")
    .map((update) => update.content);
}

function queueModelFillers(
  buffer: RealtimeStreamBuffer,
  count: number,
  prefix: string,
): void {
  const suffixes = Array.from({ length: count }).map((_value, index) =>
    String(index),
  );
  for (const suffix of suffixes) {
    buffer.queue(
      identifiedModelDelta(
        `${prefix}-session-${suffix}`,
        `${prefix}-stream-${suffix}`,
      ),
    );
  }
}

test("compacts the oldest model stream instead of evicting it at the fragment cap", () => {
  const buffer = createRealtimeStreamBuffer();
  const oldestParts = ["oldest-first", "-oldest-second"];
  queueModelParts(buffer, oldestParts);
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER - 2, "filler");
  buffer.queue(identifiedModelDelta("new-session", "new-stream"));

  expect(modelContents(buffer)).toContain(oldestParts.join(""));
});

test("compacts a protected model stream at the fragment cap", () => {
  const buffer = createRealtimeStreamBuffer();
  const parts = ["protected-first", "-protected-middle"];
  queueModelParts(buffer, parts);
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER - 2, "protected");
  const last = "-protected-last";
  parts.push(last);
  buffer.queue(identifiedModelDelta(SESSION_ID, STREAM_ID, last));

  expect(modelContents(buffer)).toContain(parts.join(""));
});

function queueRunningToolOutput(
  buffer: RealtimeStreamBuffer,
  content: string,
): void {
  for (const event of [
    orderedToolDelta(0, { state: "preparing" }),
    orderedToolDelta(1, { state: "running" }),
    orderedToolDelta(2, { content }),
  ]) {
    buffer.queue(event);
  }
}

test("preserves a protected tool stream when compacting it at the fragment cap", () => {
  const buffer = createRealtimeStreamBuffer();
  queueRunningToolOutput(buffer, "tool-first");
  buffer.queue(orderedToolDelta(3, { content: "-tool-middle" }));
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER - 2, "tool-filler");
  buffer.queue(orderedToolDelta(4, { content: "-tool-second" }));

  const outputs = drainUpdates(buffer)
    .filter((update) => update.type === "tool_update")
    .map((update) => update.entry.stdout);
  expect(outputs).toContain("tool-first-tool-middle-tool-second");
});

test("retains compact terminal identity independent of rendered payload", () => {
  const buffer = createRealtimeStreamBuffer();
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
  const staleEntry = { ...terminal.entry, state: "running" as const };
  const reconciled = buffer.applyToolSnapshot({
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    streams: [staleEntry],
    type: "tool_stream_snapshot",
  });
  expect(reconciled.streams).toEqual([]);
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
  const buffer = createRealtimeStreamBuffer();
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

function expectOrderedToolResync(buffer: RealtimeStreamBuffer): void {
  expect(buffer.takeToolResyncRequests()).toContainEqual({
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
  });
}

test("requests resync when an evicted terminal update leaves delivered running state", () => {
  const buffer = createRealtimeStreamBuffer();
  queueRunningToolOutput(buffer, "delivered-output");
  const delivered = drainUpdates(buffer).find(
    (update) =>
      update.type === "tool_update" && update.entry.state === "running",
  );
  expect(delivered).toBeDefined();

  buffer.queue(orderedToolDelta(3, { state: "completed" }));
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER, "terminal-eviction");

  expectOrderedToolResync(buffer);
});

test("requests resync when pending tool output is evicted", () => {
  const buffer = createRealtimeStreamBuffer();
  queueRunningToolOutput(buffer, "evicted-output");
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER, "tool-eviction");

  expectOrderedToolResync(buffer);
});

function queueEvictableEpoch(
  buffer: RealtimeStreamBuffer,
  fillerPrefix: string,
): void {
  const initialBarrier = buffer.markBarrier(SESSION_ID);
  buffer.queue(identifiedModelDelta(SESSION_ID, "evicted-stream", "old"));
  buffer.releaseBarrier(initialBarrier);
  queueModelFillers(buffer, MAXIMUM_TOOL_STREAMS_PER_USER - 1, fillerPrefix);
}

function takePendingBarrierUpdates(
  buffer: RealtimeStreamBuffer,
): RealtimeStreamBatch["updates"] | undefined {
  const barrier = buffer.markBarrier(SESSION_ID);
  expect(buffer.barrierPending(barrier)).toBe(true);
  return buffer.takeBarrier(barrier)?.updates;
}

test("keeps an epoch monotonic when eviction replaces its last update", () => {
  const buffer = createRealtimeStreamBuffer();
  queueEvictableEpoch(buffer, "epoch-filler");

  buffer.queue(
    identifiedModelDelta(SESSION_ID, "replacement", "earlier-on-wire"),
  );

  expect(takePendingBarrierUpdates(buffer)).toContainEqual(
    expect.objectContaining({ content: "earlier-on-wire" }),
  );
});

test("refreshes a tool update epoch after making room reclaims it", () => {
  const buffer = createRealtimeStreamBuffer();
  queueEvictableEpoch(buffer, "tool-epoch-filler");

  buffer.queue(activeToolDelta("replacement-tool"));

  const updates = takePendingBarrierUpdates(buffer);
  expect(updates?.[0]).toMatchObject({ type: "tool_update" });
  const update = updates?.[0];
  if (update?.type !== "tool_update") throw new Error("Missing tool update");
  expect(update.entry.streamId).toBe("replacement-tool");
});

test("retains an epoch while an overlapping barrier remains", () => {
  const buffer = createRealtimeStreamBuffer();
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
  const buffer = createRealtimeStreamBuffer();
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
