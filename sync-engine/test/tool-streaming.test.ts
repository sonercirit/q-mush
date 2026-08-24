import { expect, test } from "vitest";
import {
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  TOOL_STREAM_TRUNCATED_MARKER,
  applyToolStreamDelta,
  createToolStreamHubState,
  isProviderToolCallDelta,
  isRunnerCommandOutputDelta,
  isRunnerCommandResult,
  isToolStreamDeltaFrame,
  isToolStreamSnapshotFrame,
  type ToolStreamDeltaFrame,
  type ToolStreamHubState,
  type ToolStreamTerminalState,
} from "../../shared/tool-stream.ts";
import {
  ToolStreamPublisher,
  type ToolStreamTransport,
} from "../tool-stream-publisher.ts";

const SESSION_ID = "session-stream";
const USER_ID = "user-stream";

class RecordingTransport implements ToolStreamTransport {
  readonly frames: ToolStreamDeltaFrame[] = [];
  readonly store = createToolStreamHubState();
  readonly users: string[] = [];

  publishToolStream(userId: string, frame: ToolStreamDeltaFrame): void {
    this.users.push(userId);
    this.frames.push(frame);
    if (!this.store.apply(userId, frame)) {
      throw new Error("publisher emitted an invalid stream transition");
    }
  }
}

function createPublisher(streamId = "step-1") {
  const transport = new RecordingTransport();
  return {
    publisher: new ToolStreamPublisher({
      sessionId: SESSION_ID,
      streamId,
      transport,
      userId: USER_ID,
    }),
    transport,
  };
}

function frame(
  streamId: string,
  callId: string,
  index: number,
  sequence: number,
  change: Pick<
    ToolStreamDeltaFrame,
    "channel" | "content" | "previousCallId" | "state"
  >,
): ToolStreamDeltaFrame {
  return {
    callId,
    index,
    sequence,
    sessionId: SESSION_ID,
    streamId,
    type: "tool_stream",
    ...change,
  };
}

function preparingFrame(
  streamId: string,
  callId: string,
  index = 0,
): ToolStreamDeltaFrame {
  return frame(streamId, callId, index, 0, { state: "preparing" });
}

function expectProviderAccepted(
  publisher: ToolStreamPublisher,
  delta: Parameters<ToolStreamPublisher["provider"]>[0],
): void {
  expect(publisher.provider(delta)).toBe(true);
}

function expectRunnerOutputAccepted(
  publisher: ToolStreamPublisher,
  output: Parameters<ToolStreamPublisher["output"]>[1],
  accepted: boolean,
): void {
  expect(publisher.output("call-runner", output)).toBe(accepted);
}

function expectPublishedFrames(
  transport: RecordingTransport,
  expected: readonly unknown[],
): void {
  expect(transport.frames).toMatchObject(expected);
}

function expectContract(value: boolean, expected: boolean): void {
  expect(value).toBe(expected);
}

function expectRunningSessionTool(
  publisher: ToolStreamPublisher,
  callId: string,
  arguments_: string,
): void {
  expect(publisher.running(callId, "spawn_session", arguments_)).toBe(true);
}

function beginProviderReconciliation(streamId: string) {
  const setup = createPublisher(streamId);
  expectProviderAccepted(setup.publisher, {
    arguments: "{",
    id: "",
    index: 0,
    name: "re",
  });
  return setup;
}

function populateCappedHub(options?: { maximumStreamsPerUser: number }) {
  const hub = createToolStreamHubState({
    maximumStreamsPerSession: 2,
    ...options,
  });
  for (let index = 0; index < 3; index += 1) {
    expect(
      hub.apply(
        USER_ID,
        preparingFrame(`step-${String(index)}`, `call-${String(index)}`, index),
      ),
    ).toBe(true);
  }
  return hub;
}

function expectStreamCount(
  hub: ToolStreamHubState,
  streamId: string,
  count: number,
  userId = USER_ID,
): void {
  expect(hub.snapshot(userId, SESSION_ID, streamId).streams).toHaveLength(
    count,
  );
}

test("streams partial provider names and arguments into a reconnect snapshot", () => {
  const { publisher, transport } = createPublisher();

  expectProviderAccepted(publisher, {
    arguments: '{"command":',
    id: "call-1",
    index: 0,
    name: "ba",
  });
  expectProviderAccepted(publisher, {
    arguments: '"pwd"}',
    id: "",
    index: 0,
    name: "sh",
  });

  expectPublishedFrames(transport, [
    { sequence: 0, state: "preparing" },
    { channel: "name", content: "ba", sequence: 1 },
    { channel: "arguments", content: '{"command":', sequence: 2 },
    { channel: "name", content: "sh", sequence: 3 },
    { channel: "arguments", content: '"pwd"}', sequence: 4 },
  ]);
  expect(transport.store.snapshot(USER_ID, SESSION_ID, "step-1")).toEqual({
    sessionId: SESSION_ID,
    streamId: "step-1",
    streams: [
      {
        arguments: '{"command":"pwd"}',
        callId: "call-1",
        index: 0,
        name: "bash",
        sequence: 4,
        sessionId: SESSION_ID,
        state: "preparing",
        stderr: "",
        stdout: "",
        streamId: "step-1",
      },
    ],
    type: "tool_stream_snapshot",
  });
  expect(transport.users).toEqual(Array.from({ length: 5 }, () => USER_ID));
});

test("reconciles a provider placeholder with its final call ID", () => {
  const { publisher, transport } =
    beginProviderReconciliation("step-placeholder");
  expectProviderAccepted(publisher, {
    arguments: "}",
    id: "call-final",
    index: 0,
    name: "ad",
  });

  expect(transport.frames).toContainEqual(
    expect.objectContaining({
      callId: "call-final",
      previousCallId: "pending:step-placeholder:0",
      sequence: 3,
    }),
  );
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-placeholder")
      .streams[0],
  ).toMatchObject({
    arguments: "{}",
    callId: "call-final",
    name: "read",
  });
});

test("accumulates fragmented provider call IDs while reconciling placeholders", () => {
  const { publisher, transport } =
    beginProviderReconciliation("step-id-fragments");
  expectProviderAccepted(publisher, {
    arguments: "",
    id: "call-",
    index: 0,
    name: "",
  });
  expectProviderAccepted(publisher, {
    arguments: "}",
    id: "1",
    index: 0,
    name: "ad",
  });

  expect(transport.frames).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        callId: "call-",
        previousCallId: "pending:step-id-fragments:0",
      }),
      expect.objectContaining({
        callId: "call-1",
        previousCallId: "call-",
      }),
    ]),
  );
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-id-fragments")
      .streams[0],
  ).toMatchObject({
    arguments: "{}",
    callId: "call-1",
    name: "read",
  });
});

test("reconciles server-side metadata when the provider omitted it", () => {
  const { publisher, transport } = createPublisher("step-session-tool");

  expectRunningSessionTool(
    publisher,
    "call-session",
    '{"prompt":"Delegate this"}',
  );

  expectPublishedFrames(transport, [
    { callId: "call-session", sequence: 0, state: "preparing" },
    { channel: "name", content: "spawn_session", sequence: 1 },
    {
      channel: "arguments",
      content: '{"prompt":"Delegate this"}',
      sequence: 2,
    },
    { sequence: 3, state: "running" },
  ]);
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-session-tool")
      .streams[0],
  ).toMatchObject({
    arguments: '{"prompt":"Delegate this"}',
    callId: "call-session",
    name: "spawn_session",
    state: "running",
  });
});

test("preserves provider metadata when execution supplies the fallback", () => {
  const { publisher, transport } = createPublisher("step-provider-metadata");
  expectProviderAccepted(publisher, {
    arguments: '{"prompt":"Already streamed"}',
    id: "call-provider",
    index: 0,
    name: "spawn_session",
  });

  expectRunningSessionTool(
    publisher,
    "call-provider",
    '{"prompt":"Already streamed"}',
  );

  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-provider-metadata")
      .streams[0],
  ).toMatchObject({
    arguments: '{"prompt":"Already streamed"}',
    name: "spawn_session",
    state: "running",
  });
});

test("accepts contiguous runner output and rejects gaps and late deltas", () => {
  const { publisher, transport } = createPublisher();
  expect(publisher.running("call-runner", "bash")).toBe(true);

  expectRunnerOutputAccepted(
    publisher,
    { channel: "stdout", content: "one", sequence: 0 },
    true,
  );
  expectRunnerOutputAccepted(
    publisher,
    { channel: "stderr", content: "gap", sequence: 2 },
    false,
  );
  expectRunnerOutputAccepted(
    publisher,
    { channel: "stderr", content: "two", sequence: 1 },
    true,
  );
  expect(
    publisher.result("call-runner", {
      output: "canonical output",
      state: "completed",
    }),
  ).toBe(true);

  expectRunnerOutputAccepted(
    publisher,
    { channel: "stdout", content: "late", sequence: 2 },
    false,
  );

  expect(transport.frames.slice(0, 6)).toMatchObject([
    { sequence: 0, state: "preparing" },
    { channel: "name", content: "bash", sequence: 1 },
    { sequence: 2, state: "running" },
    { channel: "stdout", content: "one", sequence: 3 },
    { channel: "stderr", content: "two", sequence: 4 },
    { sequence: 5, state: "completed" },
  ]);
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-1").streams,
  ).toEqual([]);
});

test.each<ToolStreamTerminalState>([
  "completed",
  "failed",
  "canceled",
  "timed-out",
])("publishes the explicit %s terminal state", (state) => {
  const { publisher, transport } = createPublisher(`step-${state}`);
  publisher.running(`call-${state}`, "bash");

  expect(publisher.result(`call-${state}`, { output: "result", state })).toBe(
    true,
  );
  expect(transport.frames.at(-1)).toMatchObject({ state });
});

test("retry reset cancels old calls and isolates reused provider indexes", () => {
  const { publisher, transport } = createPublisher("step-before-retry");
  publisher.provider({ arguments: "{}", id: "old", index: 0, name: "read" });

  expect(publisher.reset("step-after-retry")).toBe(true);
  publisher.provider({ arguments: "{}", id: "new", index: 0, name: "read" });

  const starts = transport.frames.filter(({ state }) => state === "preparing");
  expect(starts).toMatchObject([
    { callId: "old", sequence: 0, streamId: "step-before-retry" },
    { callId: "new", sequence: 0, streamId: "step-after-retry" },
  ]);
  expect(transport.frames).toContainEqual(
    expect.objectContaining({
      callId: "old",
      state: "canceled",
      streamId: "step-before-retry",
    }),
  );
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-before-retry").streams,
  ).toEqual([]);
  expect(
    transport.store.snapshot(USER_ID, SESSION_ID, "step-after-retry").streams,
  ).toMatchObject([{ callId: "new", index: 0 }]);
});

test("bounds large streamed output and every emitted delta", () => {
  const { publisher, transport } = createPublisher("step-large");
  publisher.running("call-large", "bash");
  const chunk = "x".repeat(MAXIMUM_TOOL_STREAM_DELTA_BYTES);
  for (let sequence = 0; sequence < 10; sequence += 1) {
    expect(
      publisher.output("call-large", {
        channel: "stdout",
        content: chunk,
        sequence,
      }),
    ).toBe(true);
  }

  const contents = transport.frames.flatMap(({ content }) =>
    content === undefined ? [] : [content],
  );
  expect(
    contents.every(
      (content) =>
        Buffer.byteLength(content) <= MAXIMUM_TOOL_STREAM_DELTA_BYTES,
    ),
  ).toBe(true);
  const snapshot = transport.store.snapshot(USER_ID, SESSION_ID, "step-large")
    .streams[0];
  expect(snapshot?.stdout.endsWith(TOOL_STREAM_TRUNCATED_MARKER)).toBe(true);
  expect(Buffer.byteLength(snapshot?.stdout ?? "")).toBeLessThanOrEqual(
    MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  );
});

test("the shared reducer rejects outbound gaps, duplicates, and late deltas", () => {
  const preparing = frame("step-reducer", "call-1", 0, 0, {
    state: "preparing",
  });
  const started = applyToolStreamDelta(undefined, preparing);
  expect(started.accepted).toBe(true);
  if (!started.accepted) {
    throw new Error("expected the initial transition to be accepted");
  }

  expect(
    applyToolStreamDelta(
      started.entry,
      frame("step-reducer", "call-1", 0, 2, {
        channel: "name",
        content: "gap",
      }),
    ),
  ).toMatchObject({ accepted: false, reason: "gap" });
  const named = applyToolStreamDelta(
    started.entry,
    frame("step-reducer", "call-1", 0, 1, {
      channel: "name",
      content: "read",
    }),
  );
  expect(named.accepted).toBe(true);
  if (!named.accepted) {
    throw new Error("expected the contiguous transition to be accepted");
  }
  expect(
    applyToolStreamDelta(
      named.entry,
      frame("step-reducer", "call-1", 0, 1, {
        channel: "arguments",
        content: "late",
      }),
    ),
  ).toMatchObject({ accepted: false, reason: "late" });
});

test("snapshot state is capped per user-session store", () => {
  const hub = populateCappedHub();

  expectStreamCount(hub, "step-0", 0);
  expectStreamCount(hub, "step-1", 1);
  expectStreamCount(hub, "step-2", 1);
});

test("per-user hub state bounds sessions and isolates users", () => {
  const hub = populateCappedHub({ maximumStreamsPerUser: 2 });
  expect(
    hub.apply("other-user", preparingFrame("other-step", "other-call")),
  ).toBe(true);

  expectStreamCount(hub, "step-0", 0);
  expectStreamCount(hub, "step-2", 1);
  expectStreamCount(hub, "other-step", 1, "other-user");

  hub.clearSession(USER_ID, SESSION_ID);
  expectStreamCount(hub, "step-2", 0);
  expectStreamCount(hub, "other-step", 1, "other-user");
});

test("reconnect snapshots replace stale state without rolling back newer deltas", () => {
  const store = createToolStreamHubState();
  const apply = (delta: ToolStreamDeltaFrame): boolean =>
    store.apply(USER_ID, delta);
  apply(frame("step-reconnect", "current-call", 1, 0, { state: "preparing" }));
  apply(
    frame("step-reconnect", "current-call", 1, 1, {
      channel: "name",
      content: "newer",
    }),
  );
  apply(frame("step-reconnect", "stale-call", 0, 0, { state: "preparing" }));
  const snapshot = {
    sessionId: SESSION_ID,
    streamId: "step-reconnect",
    streams: [
      {
        arguments: "{}",
        callId: "current-call",
        index: 1,
        name: "read",
        sequence: 0,
        sessionId: SESSION_ID,
        state: "running" as const,
        stderr: "",
        stdout: "current",
        streamId: "step-reconnect",
      },
    ],
    type: "tool_stream_snapshot" as const,
  };

  expect(isToolStreamSnapshotFrame(snapshot)).toBe(true);
  expect(store.replace(USER_ID, snapshot)).toBe(true);
  expect(store.snapshot(USER_ID, SESSION_ID, "step-reconnect").streams).toEqual(
    [
      expect.objectContaining({
        callId: "current-call",
        name: "newer",
        sequence: 1,
      }),
    ],
  );
  const onlyStream = snapshot.streams[0];
  if (onlyStream === undefined) {
    throw new Error("expected the reconnect fixture to contain one stream");
  }
  expect(
    store.replace(USER_ID, {
      ...snapshot,
      streams: [onlyStream, onlyStream],
    }),
  ).toBe(false);
});

test("validates the provider, broker, and realtime integration contracts", () => {
  expectContract(
    isProviderToolCallDelta({
      arguments: "{}",
      id: "call",
      index: 0,
      name: "read",
    }),
    true,
  );
  expectContract(
    isRunnerCommandOutputDelta({
      channel: "stdout",
      content: "ok",
      sequence: 0,
    }),
    true,
  );
  expectContract(
    isRunnerCommandResult({ output: "ok", state: "timed-out" }),
    true,
  );
  expectContract(
    isToolStreamDeltaFrame(preparingFrame("step-codec", "call-codec")),
    true,
  );

  expectContract(
    isRunnerCommandOutputDelta({
      channel: "stdout",
      content: "gap",
      sequence: -1,
    }),
    false,
  );
  expectContract(
    isToolStreamDeltaFrame({
      ...frame("step-codec", "call-codec", 0, 1, {
        channel: "stdout",
        content: "both",
      }),
      state: "running",
    }),
    false,
  );
});

test("transport failures never interrupt canonical tool execution", () => {
  const publisher = new ToolStreamPublisher({
    sessionId: SESSION_ID,
    streamId: "step-throwing-transport",
    transport: {
      publishToolStream: () => {
        throw new Error("socket closed");
      },
    },
    userId: USER_ID,
  });

  expect(publisher.running("call-1", "bash")).toBe(true);
  expect(
    publisher.result("call-1", {
      output: "still completed",
      state: "completed",
    }),
  ).toBe(true);
});
