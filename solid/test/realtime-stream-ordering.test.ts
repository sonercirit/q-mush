import { expect, test } from "vitest";
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
): StreamingTestConnection {
  const stream = streamingRealtimeFixture(instanceId, listener);
  return {
    ...stream,
    batches: () =>
      stream.emitted.filter((event) => event.type === "stream_batch"),
  };
}

function modelDelta(
  content: string,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return {
    content,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    thinking: "",
    type: "session_delta",
  };
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

function expectNextFrame(stream: StreamingTestConnection): void {
  expect(stream.pendingFrames).toHaveLength(1);
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

function expectBatch(
  stream: StreamingTestConnection,
  index: number,
  expected: Readonly<Record<string, unknown>>,
): void {
  expect(stream.batches()[index]?.updates).toMatchObject([expected]);
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
  expect(stream.batches()).toHaveLength(1);
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

test("bounds sustained mixed streams to one ordered update per frame", () => {
  const stream = streamingTestConnection("ordered-instance");
  stream.receive(modelDelta("model-1"));
  sendRunningTool(stream, "tool-1");

  expectNextFrame(stream);
  expectBatch(stream, 0, { content: "model-1", type: "session_delta" });
  expect(stream.pendingFrames).toHaveLength(1);

  stream.receive(modelDelta("model-2"));
  stream.receive(toolDelta(3, { content: "+tool-2" }));
  expectNextFrame(stream);
  expectBatch(stream, 1, {
    entry: { sequence: 3, stdout: "tool-1+tool-2" },
    terminal: false,
    type: "tool_update",
  });
  expect(stream.pendingFrames).toHaveLength(1);

  expectNextFrame(stream);
  expectBatch(stream, 2, { content: "model-2", type: "session_delta" });
  expect(stream.pendingFrames).toHaveLength(0);
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

  expect(stream.batches()).toHaveLength(1);
  expect(stream.batches()[0]?.updates).toMatchObject([
    { entry: { index: 0, stdout: "first" }, type: "tool_update" },
    { entry: { index: 1, stdout: "second" }, type: "tool_update" },
  ]);
  expectSingleSnapshotBarrier(stream);
  stream.stop();
});

test("flushes tool terminal state before stale snapshots without resurrection", () => {
  const stream = streamingTestConnection("snapshot-instance");
  sendRunningTool(stream, "complete output");
  stream.receive(toolDelta(3, { state: "completed" }));
  receiveSnapshotBarrier(stream, toolSnapshot(2, "complete output"));

  expectToolSnapshotBarrier(
    stream,
    {
      entry: { sequence: 3, stdout: "complete output" },
      terminal: true,
      type: "tool_update",
    },
    [],
  );
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

  const initialSocket = stream.setup.sockets[0];
  initialSocket?.close();
  stream.setup.timers.shift()?.();
  const reconnected = stream.setup.sockets[1];
  reconnected?.open("paused-reconnected-instance");
  expectToolSync(reconnected?.sent);

  reconnected?.receive(toolDelta(3, { state: "completed" }));
  expectNextFrame(stream);

  expectBatch(stream, 0, {
    entry: { sequence: 3, stdout: "question output" },
    terminal: true,
    type: "tool_update",
  });
  expect(controller.state.toolStreams).toEqual([]);
  stream.stop();
});
