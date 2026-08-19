import { expect, test } from "vitest";
import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type {
  RealtimeClientEvent,
  RealtimeStreamBatch,
  RealtimeStreamUpdate,
} from "../realtime-stream-buffer.ts";
import { SessionController } from "../session-controller.ts";
import {
  identifiedModelDelta,
  orderedToolDelta,
  preparingToolDelta,
} from "./realtime-stream-event-fixtures.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
const SESSION_ID = "session-ordered";
const STREAM_ID = "stream-ordered";
interface StreamingTestConnection extends ReturnType<
  typeof streamingRealtimeFixture
> {
  readonly batches: () => readonly RealtimeStreamBatch[];
}
function streamingTestConnection(
  instanceId: string,
  listener?: (event: RealtimeClientEvent) => void,
  options: Parameters<typeof streamingRealtimeFixture>[2] = {},
): StreamingTestConnection {
  const stream = streamingRealtimeFixture(instanceId, listener, options);
  return {
    ...stream,
    batches: () =>
      stream.emitted.filter((event) => event.type === "stream_batch"),
  };
}
function modelDelta(
  content: string,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return identifiedModelDelta(SESSION_ID, STREAM_ID, content);
}
function toolSnapshot(
  sequence: number,
  stdout: string,
): Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }> {
  const stream = {
    arguments: "",
    callId: "ordered-call",
    index: 0,
    name: "",
    sequence,
    sessionId: SESSION_ID,
    state: "running" as const,
    stderr: "",
    stdout,
    streamId: STREAM_ID,
  };
  return snapshotWithStreams([stream]);
}
function snapshotWithStreams(
  streams: Extract<
    RealtimeServerEvent,
    { type: "tool_stream_snapshot" }
  >["streams"],
): Extract<RealtimeServerEvent, { type: "tool_stream_snapshot" }> {
  return {
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    streams,
    type: "tool_stream_snapshot",
  };
}
function expectNoPendingFrames(stream: StreamingTestConnection): void {
  expect(stream.pendingFrames).toEqual([]);
}
function expectOnePendingFrame(stream: StreamingTestConnection): void {
  expect(stream.pendingFrames).toHaveLength(1);
}
function expectBatchCount(
  stream: StreamingTestConnection,
  count: number,
): void {
  expect(stream.batches()).toHaveLength(count);
}
function expectNextFrame(stream: StreamingTestConnection): void {
  expectOnePendingFrame(stream);
  stream.pendingFrames.shift()?.();
}
function drainFrames(stream: StreamingTestConnection): void {
  while (stream.pendingFrames.length !== 0) stream.pendingFrames.shift()?.();
}
function expectToolSync(
  sent: readonly string[] | undefined,
  streamId = STREAM_ID,
): void {
  expect(sent).toContain(
    JSON.stringify({
      sessionId: SESSION_ID,
      streamId,
      type: "sync_tools",
    }),
  );
}
function expectedToolUpdate(
  sequence: number,
  stdout: string,
): Readonly<Record<string, unknown>> {
  return {
    entry: { sequence, stdout },
    terminal: false,
    type: "tool_update",
  };
}
function receiveModelKeys(
  stream: StreamingTestConnection,
  count: number,
  sessionId: (index: number) => string,
  streamId: (index: number) => string,
): void {
  Array.from({ length: count }, (_, index) => index).forEach((index) => {
    stream.receive(identifiedModelDelta(sessionId(index), streamId(index)));
  });
}
function receiveSessionModels(
  stream: StreamingTestConnection,
  count: number,
  sessionId: string,
  prefix: string,
): void {
  receiveModelKeys(
    stream,
    count,
    () => sessionId,
    (index) => `${prefix}-${String(index)}`,
  );
}
function nextBatchUpdates(
  stream: StreamingTestConnection,
  batchIndex: number,
): readonly RealtimeStreamUpdate[] {
  expectNextFrame(stream);
  return stream.batches()[batchIndex]?.updates ?? [];
}
function drainExpectedFrame(
  stream: StreamingTestConnection,
  batchIndex: number,
  expected: readonly Readonly<Record<string, unknown>>[],
): void {
  expect(nextBatchUpdates(stream, batchIndex)).toMatchObject(expected);
}
function expectBarrierBatch(
  stream: StreamingTestConnection,
  batchIndex: number,
  updates: number,
): void {
  expect(nextBatchUpdates(stream, batchIndex)).toHaveLength(updates);
  expect(stream.emitted.some(({ type }) => type === "session")).toBe(false);
}
function expectBatch(
  stream: StreamingTestConnection,
  index: number,
  expected: Readonly<Record<string, unknown>>,
  updateIndex = 0,
): void {
  expect(stream.batches()[index]?.updates[updateIndex]).toMatchObject(expected);
}
function sendRunningTool(
  stream: StreamingTestConnection,
  output: string,
): void {
  stream.receive(orderedToolDelta(0, { state: "preparing" }));
  stream.receive(orderedToolDelta(1, { state: "running" }));
  stream.receive(orderedToolDelta(2, { content: output }));
}
function receiveSnapshotBarrier(
  stream: StreamingTestConnection,
  snapshot = snapshotWithStreams([]),
): void {
  stream.receive(snapshot);
  while (
    stream.pendingFrames.length > 0 &&
    !stream.emitted.some((event) => event.type === "tool_stream_snapshot")
  ) {
    stream.pendingFrames.shift()?.();
  }
}
function expectSingleSnapshotBarrier(stream: StreamingTestConnection): void {
  expect(stream.emitted.map(({ type }) => type)).toEqual([
    "stream_batch",
    "tool_stream_snapshot",
  ]);
  expectNoPendingFrames(stream);
  expectBatchCount(stream, 1);
}
function expectToolSnapshotBarrier(
  stream: StreamingTestConnection,
  update: Readonly<Record<string, unknown>>,
  streams: readonly Readonly<Record<string, unknown>>[],
): void {
  expectBatch(stream, 0, update);
  expect(stream.emitted[1]).toMatchObject({
    streams,
    type: "tool_stream_snapshot",
  });
  expectSingleSnapshotBarrier(stream);
  stream.stop();
}
test("keeps tool deltas queued after a questions barrier", () => {
  const stream = streamingTestConnection("questions-barrier-instance");
  sendRunningTool(stream, "A");
  stream.receive({
    pending: null,
    sessionId: SESSION_ID,
    type: "session_questions",
  });
  stream.receive(orderedToolDelta(3, { content: "B" }));
  stream.receive(orderedToolDelta(4, { content: "C" }));
  const sent = stream.setup.sockets.at(0)?.sent;
  expect(sent).toBeDefined();
  sent?.splice(0);
  drainFrames(stream);
  expect(stream.batches()).toMatchObject([
    { updates: [expectedToolUpdate(2, "A")] },
    { updates: [expectedToolUpdate(4, "ABC")] },
  ]);
  expect(stream.emitted.some(({ type }) => type === "session_questions")).toBe(
    true,
  );
  expect(sent).toEqual([]);
  stream.stop();
});
test("bounds sustained mixed streams to one ordered batch per frame", () => {
  const stream = streamingTestConnection("ordered-instance");
  stream.receive(modelDelta("model-1"));
  sendRunningTool(stream, "tool-1");
  expectNextFrame(stream);
  expectBatch(stream, 0, { content: "model-1", type: "session_delta" });
  expectBatch(stream, 0, expectedToolUpdate(2, "tool-1"), 1);
  expectNoPendingFrames(stream);
  stream.receive(modelDelta("model-2"));
  stream.receive(orderedToolDelta(3, { content: "+tool-2" }));
  expectNextFrame(stream);
  expectBatch(stream, 1, { content: "model-2", type: "session_delta" });
  expectBatch(stream, 1, expectedToolUpdate(3, "tool-1+tool-2"), 1);
  expectNoPendingFrames(stream);
  stream.stop();
});
test("drains several keys per frame and prioritizes the selected session", () => {
  const stream = streamingTestConnection("multi-key-instance", undefined, {
    selectedSession: () => SESSION_ID,
  });
  const otherSessionId = "session-background";
  receiveSessionModels(stream, 8, otherSessionId, "background");
  stream.receive(modelDelta("selected-model"));
  stream.receive(preparingToolDelta(0, "selected-tool-0", "call-0"));
  stream.receive(preparingToolDelta(1, "selected-tool-1", "call-1"));
  stream.receive(preparingToolDelta(2, "selected-tool-2", "call-2"));
  expectBarrierBatch(stream, 0, 4);
  expect(stream.batches()[0]?.updates).toMatchObject([
    { content: "selected-model", sessionId: SESSION_ID },
    { content: "background-0", sessionId: otherSessionId },
    { entry: { index: 0, sessionId: SESSION_ID } },
    { content: "background-1", sessionId: otherSessionId },
  ]);
  expectOnePendingFrame(stream);
  stream.stop();
});
test("rotates fairly between background sessions", () => {
  const selectedSessionId = "session-selected";
  const stream = streamingTestConnection(
    "background-fairness-instance",
    undefined,
    {
      selectedSession: () => selectedSessionId,
    },
  );
  for (const sessionId of ["background-a", "background-b", "background-c"]) {
    receiveSessionModels(stream, 2, sessionId, sessionId);
  }
  receiveSessionModels(stream, 4, selectedSessionId, "selected");
  drainExpectedFrame(stream, 0, [
    { sessionId: selectedSessionId, streamId: "selected-0" },
    { sessionId: "background-a", streamId: "background-a-0" },
    { sessionId: selectedSessionId, streamId: "selected-1" },
    { sessionId: "background-b", streamId: "background-b-0" },
  ]);
  drainExpectedFrame(stream, 1, [
    { sessionId: selectedSessionId, streamId: "selected-2" },
    { sessionId: "background-c", streamId: "background-c-0" },
    { sessionId: selectedSessionId, streamId: "selected-3" },
    { sessionId: "background-a", streamId: "background-a-1" },
  ]);
  stream.stop();
});
test("keeps alternating turns across one-update frames", () => {
  let clock = 0;
  const selectedSessionId = "session-selected";
  const stream = streamingTestConnection(
    "cross-frame-fairness-instance",
    undefined,
    {
      now: () => {
        clock += 9;
        return clock;
      },
      selectedSession: () => selectedSessionId,
    },
  );
  for (const sessionId of [selectedSessionId, "background-a", "background-b"]) {
    receiveSessionModels(stream, 3, sessionId, sessionId);
  }
  drainExpectedFrame(stream, 0, [
    { sessionId: selectedSessionId, streamId: `${selectedSessionId}-0` },
  ]);
  drainExpectedFrame(stream, 1, [
    { sessionId: "background-a", streamId: "background-a-0" },
  ]);
  drainExpectedFrame(stream, 2, [
    { sessionId: selectedSessionId, streamId: `${selectedSessionId}-1` },
  ]);
  drainExpectedFrame(stream, 3, [
    { sessionId: "background-b", streamId: "background-b-0" },
  ]);
  stream.stop();
});
test("reprioritizes queued work after the selected session changes", () => {
  let selected = SESSION_ID;
  const stream = streamingTestConnection(
    "selection-change-instance",
    undefined,
    {
      selectedSession: () => selected,
    },
  );
  stream.receive(modelDelta("previous selection"));
  stream.receive(
    identifiedModelDelta("session-new", "new-selection", "new selection"),
  );
  selected = "session-new";
  expectNextFrame(stream);
  expectBatch(stream, 0, {
    content: "new selection",
    sessionId: "session-new",
  });
  stream.stop();
});
test("bounds a stream frame by elapsed work", () => {
  let clock = 0;
  const stream = streamingTestConnection("timed-frame-instance", undefined, {
    now: () => {
      clock += 5;
      return clock;
    },
  });
  receiveModelKeys(
    stream,
    8,
    (index) => `timed-session-${String(index)}`,
    (index) => `timed-${String(index)}`,
  );
  stream.pendingFrames.shift()?.();
  expect(stream.batches()[0]?.updates).toHaveLength(2);
  expect(stream.pendingFrames).not.toEqual([]);
  stream.stop();
});
test("drains a snapshot barrier incrementally before applying its state", () => {
  const stream = streamingTestConnection("incremental-barrier-instance");
  receiveSessionModels(stream, 9, SESSION_ID, "barrier-model");
  stream.receive({
    session: {
      ...TEST_SESSION_DETAIL,
      id: SESSION_ID,
      status: "running",
    },
    type: "session",
  });
  expect(stream.pendingFrames).toHaveLength(2);
  stream.pendingFrames.shift()?.();
  expect(stream.emitted).toEqual([]);
  expectBarrierBatch(stream, 0, 4);
  expectBarrierBatch(stream, 1, 4);
  expectBarrierBatch(stream, 2, 1);
  expectNextFrame(stream);
  expect(stream.emitted.at(-1)?.type).toBe("session");
  stream.stop();
});
test("keeps a newer buffered tool entry through a stale snapshot", () => {
  const stream = streamingTestConnection("stale-snapshot-instance");
  sendRunningTool(stream, "new output");
  receiveSnapshotBarrier(stream, toolSnapshot(1, "stale output"));
  expectToolSnapshotBarrier(
    stream,
    {
      entry: { sequence: 2, stdout: "new output" },
      terminal: false,
      type: "tool_update",
    },
    [{ sequence: 2, stdout: "new output" }],
  );
});
test("flushes concurrent tools as one snapshot barrier batch", () => {
  const stream = streamingTestConnection("concurrent-snapshot-instance");
  sendRunningTool(stream, "first");
  for (const event of [
    {
      ...orderedToolDelta(0, { state: "preparing" }),
      callId: "second-call",
      index: 1,
    },
    {
      ...orderedToolDelta(1, { state: "running" }),
      callId: "second-call",
      index: 1,
    },
    {
      ...orderedToolDelta(2, { content: "second" }),
      callId: "second-call",
      index: 1,
    },
  ]) {
    stream.receive(event);
  }
  receiveSnapshotBarrier(stream);
  expectBatchCount(stream, 1);
  expectBatch(stream, 0, {
    entry: { index: 0, stdout: "first" },
    type: "tool_update",
  });
  expectBatch(
    stream,
    0,
    {
      entry: { index: 1, stdout: "second" },
      type: "tool_update",
    },
    1,
  );
  expectSingleSnapshotBarrier(stream);
  stream.stop();
});
test("keeps terminal state through repeated stale snapshots without revival", () => {
  const stream = streamingTestConnection("snapshot-instance");
  const staleSnapshot = toolSnapshot(2, "complete output");
  sendRunningTool(stream, "complete output");
  stream.receive(orderedToolDelta(3, { state: "completed" }));
  receiveSnapshotBarrier(stream, staleSnapshot);
  expectBatch(stream, 0, {
    entry: { sequence: 3, stdout: "complete output" },
    terminal: true,
    type: "tool_update",
  });
  expect(stream.emitted[1]).toMatchObject({
    streams: [],
    type: "tool_stream_snapshot",
  });
  expectSingleSnapshotBarrier(stream);
  stream.emitted.length = 0;
  receiveSnapshotBarrier(stream, staleSnapshot);
  expect(stream.emitted).toMatchObject([
    { streams: [], type: "tool_stream_snapshot" },
  ]);
  expectNoPendingFrames(stream);
  stream.stop();
});
test("does not schedule frames for rejected terminal continuations", () => {
  const stream = streamingTestConnection("terminal-rejection-instance");
  sendRunningTool(stream, "done");
  const terminal = orderedToolDelta(3, { state: "completed" });
  stream.receive(terminal);
  expectNextFrame(stream);
  expectNoPendingFrames(stream);
  stream.receive(terminal);
  expectNoPendingFrames(stream);
  stream.stop();
});
test("discards buffered fragments from a disconnected socket", () => {
  const stream = streamingTestConnection("disconnect-instance");
  stream.receive(modelDelta("old model"));
  stream.receive(preparingToolDelta(0, "old-tool", "call-0"));
  expectOnePendingFrame(stream);
  const reconnected = stream.reconnect("reconnected-instance");
  stream.emitted.length = 0;
  stream.pendingFrames.shift()?.();
  expect(stream.batches()).toEqual([]);
  reconnected.receive(modelDelta("new model"));
  expectNextFrame(stream);
  expectBatchCount(stream, 1);
  expectBatch(stream, 0, { content: "new model", type: "session_delta" });
  stream.stop();
});
function receiveToolLifecycle(
  stream: StreamingTestConnection,
  index: number,
  streamId: string,
  callId: string,
): void {
  const preparing = preparingToolDelta(index, streamId, callId);
  stream.receive({ ...preparing, state: "preparing" });
  expectNextFrame(stream);
  stream.receive({ ...preparing, sequence: 1, state: "completed" });
  expectNextFrame(stream);
}
test("synchronizes only active tool streams on session state", () => {
  const stream = streamingTestConnection("active-sync-instance");
  const activeStreamId = "tool-stream-active";
  const active = preparingToolDelta(0, activeStreamId, "call-active");
  stream.receive({ ...active, state: "preparing" });
  expectNextFrame(stream);
  for (let index = 0; index < 30; index += 1) {
    const streamId = `tool-stream-${String(index)}`;
    const callId = `call-${String(index)}`;
    receiveToolLifecycle(stream, index, streamId, callId);
  }
  const socket = stream.setup.sockets[0];
  socket?.sent.splice(0);
  const runningSession = {
    ...TEST_SESSION_DETAIL,
    id: SESSION_ID,
    status: "running" as const,
  };
  stream.receive({ session: runningSession, type: "session" });
  expectNextFrame(stream);
  expect(socket?.sent).toEqual([
    JSON.stringify({
      sessionId: SESSION_ID,
      streamId: activeStreamId,
      type: "sync_tools",
    }),
  ]);
  stream.stop();
});
test("reconnect synchronizes every observed tool stream", () => {
  const firstStreamId = "tool-stream-a";
  const secondStreamId = "tool-stream-b";
  const stream = streamingTestConnection("multi-stream-instance");
  stream.receive({
    ...preparingToolDelta(0, firstStreamId, "call-0"),
    state: "preparing",
  });
  expectNextFrame(stream);
  stream.receive({
    ...preparingToolDelta(1, secondStreamId, "call-1"),
    state: "preparing",
  });
  const reconnected = stream.reconnect("multi-stream-reconnected");
  expectToolSync(reconnected.sent, firstStreamId);
  expect(reconnected.sent).toHaveLength(1);
  stream.stop();
});
function selectedRunningController(): SessionController {
  const detail = {
    ...TEST_SESSION_DETAIL,
    id: SESSION_ID,
    status: "running" as const,
  };
  return new SessionController(sessionDetailState(detail), undefined, null);
}
function applyStreamEvent(
  controller: SessionController,
  event: RealtimeClientEvent,
): void {
  if (event.type === "session") controller.applyDetail(event.session);
  else if (event.type === "stream_batch") controller.applyStreamBatch(event);
  else if (event.type === "tool_stream_snapshot")
    controller.applyToolSnapshot(event);
}
test("keeps paused ask-questions tool state through terminal output and reconnect", () => {
  const controller = selectedRunningController();
  const stream = streamingTestConnection("paused-instance", (event) => {
    applyStreamEvent(controller, event);
  });
  sendRunningTool(stream, "question output");
  receiveSnapshotBarrier(stream, toolSnapshot(2, "question output"));
  expect(controller.state.toolStreams).toMatchObject([
    { state: "running", stdout: "question output" },
  ]);
  stream.emitted.length = 0;
  while (stream.pendingFrames.length > 0) stream.pendingFrames.shift()?.();
  stream.receive({
    session: {
      ...TEST_SESSION_DETAIL,
      generation: 2,
      id: SESSION_ID,
      pendingQuestions: {
        createdAt: 3,
        executionGeneration: 2,
        id: "paused-questions",
        questions: [
          {
            id: "direction",
            options: [
              { label: "Continue", value: "continue" },
              { label: "Stop", value: "stop" },
            ],
            prompt: "What next?",
            type: "single_choice",
          },
        ],
        toolCallId: "ordered-call",
      },
      status: "paused",
    },
    type: "session",
  });
  expectNextFrame(stream);
  expectToolSync(stream.setup.sockets[0]?.sent);
  expect(controller.state.detail).toMatchObject({
    pendingQuestions: { id: "paused-questions" },
    status: "paused",
  });
  const reconnected = stream.reconnect("paused-reconnected-instance");
  expectToolSync(reconnected.sent);
  reconnected.receive(orderedToolDelta(3, { state: "completed" }));
  expectNextFrame(stream);
  expectBatch(stream, 0, {
    entry: { sequence: 3, stdout: "question output" },
    terminal: true,
    type: "tool_update",
  });
  expect(controller.state.toolStreams).toEqual([]);
  stream.stop();
});
