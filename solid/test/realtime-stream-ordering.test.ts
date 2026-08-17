import { expect, test } from "vitest";
import { MAXIMUM_TOOL_STREAMS_PER_SESSION } from "../../shared/tool-stream.ts";
import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type {
  RealtimeClientEvent,
  RealtimeStreamBatch,
} from "../realtime-stream-buffer.ts";
import { SessionController } from "../session-controller.ts";
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

function identifiedModelDelta(
  sessionId: string,
  streamId: string,
  content = streamId,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return {
    content,
    sessionId,
    streamId,
    thinking: "",
    type: "session_delta",
  };
}

function indexedToolDelta(
  index: number,
  streamId: string,
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  return {
    callId: `call-${String(index)}`,
    index,
    sequence: 0,
    sessionId: SESSION_ID,
    state: "preparing",
    streamId,
    type: "tool_stream",
  };
}

function modelDelta(
  content: string,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return identifiedModelDelta(SESSION_ID, STREAM_ID, content);
}

function toolDelta(
  sequence: number,
  change:
    | { readonly state: "completed" | "preparing" | "running" }
    | { readonly content: string },
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  const identity = {
    callId: "ordered-call",
    index: 0,
    sequence,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    type: "tool_stream" as const,
  };
  return "state" in change
    ? { ...identity, state: change.state }
    : { ...identity, channel: "stdout", content: change.content };
}

function terminalStream(
  index: number,
  streamId: string,
  callId = `terminal-call-${String(index)}`,
  output?: string,
): readonly RealtimeServerEvent[] {
  const identity = {
    callId,
    index,
    sessionId: SESSION_ID,
    streamId,
    type: "tool_stream" as const,
  };
  const running = [
    { ...identity, sequence: 0, state: "preparing" as const },
    { ...identity, sequence: 1, state: "running" as const },
  ];
  return output === undefined
    ? [...running, { ...identity, sequence: 2, state: "completed" as const }]
    : [
        ...running,
        {
          ...identity,
          channel: "stdout" as const,
          content: output,
          sequence: 2,
        },
        { ...identity, sequence: 3, state: "completed" as const },
      ];
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

function expectToolSync(sent: readonly string[] | undefined): void {
  expect(sent).toContain(
    JSON.stringify({
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
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

function drainExpectedFrame(
  stream: StreamingTestConnection,
  batchIndex: number,
  expected: readonly Readonly<Record<string, unknown>>[],
): void {
  expectNextFrame(stream);
  expect(stream.batches()[batchIndex]?.updates).toMatchObject(expected);
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
  stream.receive(toolDelta(0, { state: "preparing" }));
  stream.receive(toolDelta(1, { state: "running" }));
  stream.receive(toolDelta(2, { content: output }));
}

function receiveSnapshotBarrier(
  stream: StreamingTestConnection,
  snapshot = snapshotWithStreams([]),
): void {
  stream.receive(snapshot);
}

function expectSingleSnapshotBarrier(stream: StreamingTestConnection): void {
  expect(stream.emitted.map(({ type }) => type)).toEqual([
    "stream_batch",
    "tool_stream_snapshot",
  ]);
  expectNextFrame(stream);
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

test("bounds sustained mixed streams to one ordered batch per frame", () => {
  const stream = streamingTestConnection("ordered-instance");
  stream.receive(modelDelta("model-1"));
  sendRunningTool(stream, "tool-1");

  expectNextFrame(stream);
  expectBatch(stream, 0, { content: "model-1", type: "session_delta" });
  expectBatch(stream, 0, expectedToolUpdate(2, "tool-1"), 1);
  expectNoPendingFrames(stream);

  stream.receive(modelDelta("model-2"));
  stream.receive(toolDelta(3, { content: "+tool-2" }));
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
  stream.receive(indexedToolDelta(0, "selected-tool-0"));
  stream.receive(indexedToolDelta(1, "selected-tool-1"));
  stream.receive(indexedToolDelta(2, "selected-tool-2"));

  expectNextFrame(stream);

  expect(stream.batches()[0]?.updates).toHaveLength(4);
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
      ...toolDelta(0, { state: "preparing" }),
      callId: "second-call",
      index: 1,
    },
    { ...toolDelta(1, { state: "running" }), callId: "second-call", index: 1 },
    { ...toolDelta(2, { content: "second" }), callId: "second-call", index: 1 },
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
  stream.receive(toolDelta(3, { state: "completed" }));
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
  const terminal = toolDelta(3, { state: "completed" });
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
  stream.receive(indexedToolDelta(0, "old-tool"));
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

test("bounds terminal tombstones and permits evicted tool-key reuse", () => {
  const stream = streamingTestConnection("terminal-cap-instance");
  const terminalCount = MAXIMUM_TOOL_STREAMS_PER_SESSION + 1;
  const terminalOutput = "x".repeat(32 * 1_024);
  for (let index = 0; index < terminalCount; index += 1) {
    const streamId = `terminal-step-${String(index)}`;
    for (const event of terminalStream(
      index,
      streamId,
      undefined,
      terminalOutput,
    )) {
      stream.receive(event);
    }
    expectNextFrame(stream);
  }

  const reusedStreamId = "terminal-step-0";
  for (const event of terminalStream(0, reusedStreamId, "reused-call")) {
    stream.receive(event);
  }
  expectNextFrame(stream);

  expectBatchCount(stream, terminalCount + 1);
  expectBatch(stream, terminalCount, {
    entry: { callId: "reused-call", sequence: 2, state: "completed" },
    terminal: true,
    type: "tool_update",
  });
  expectNoPendingFrames(stream);
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
  expectToolSync(stream.setup.sockets[0]?.sent);
  expectNextFrame(stream);
  expect(controller.state.detail).toMatchObject({
    pendingQuestions: { id: "paused-questions" },
    status: "paused",
  });

  const reconnected = stream.reconnect("paused-reconnected-instance");
  expectToolSync(reconnected.sent);

  reconnected.receive(toolDelta(3, { state: "completed" }));
  expectNextFrame(stream);

  expectBatch(stream, 0, {
    entry: { sequence: 3, stdout: "question output" },
    terminal: true,
    type: "tool_update",
  });
  expect(controller.state.toolStreams).toEqual([]);
  stream.stop();
});
