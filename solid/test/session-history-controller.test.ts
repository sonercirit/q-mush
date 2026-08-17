import { expect, test, vi } from "vitest";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { RealtimeStreamBatch } from "../realtime-stream-buffer.ts";
import type { SessionViewState } from "../session-client.tsx";
import { initialSessionViewState } from "../session-state.ts";

const EXPECTED_TOOL_OUTPUTS = ["first tool", "second tool"] as const;

const STREAM_MUTATION_CASES = [
  { name: "question answer", state: { answeringQuestions: true } },
  { name: "compaction", state: { compacting: true } },
  { name: "creation", state: { creating: true } },
  { name: "fork", state: { forking: true } },
  { name: "reassignment", state: { reassigning: true } },
  { name: "send", state: { sending: true } },
  { name: "stop", state: { stopping: true } },
  { name: "tool update", state: { updatingTools: true } },
] as const satisfies readonly {
  readonly name: string;
  readonly state: Partial<SessionViewState>;
}[];

const historicalPage = {
  currentSegment: 1,
  messages: [
    {
      content: "Before compaction",
      createdAt: 1,
      id: "old-message",
      images: [],
      role: "user" as const,
      toolCallId: null,
      toolCalls: [],
      toolName: null,
    },
  ],
  newerCursor: null,
  olderCursor: null,
  segment: 0,
  sessionId: TEST_SESSION_DETAIL.id,
};

function streamEntry(index: number, output: string): ToolStreamEntry {
  return {
    arguments: "",
    callId: `stream-call-${String(index)}`,
    index,
    name: "bash",
    sequence: 2,
    sessionId: TEST_SESSION_DETAIL.id,
    state: "running",
    stderr: "",
    stdout: output,
    streamId: "stream-batch",
  };
}

function selectedController(
  detail: typeof TEST_SESSION_DETAIL,
  extra: Partial<SessionViewState> = {},
): SessionController {
  const state: SessionViewState = {
    ...initialSessionViewState(),
    ...extra,
    detail,
    selectedId: detail.id,
  };
  return new SessionController(
    createReactiveState(state),
    undefined,
    undefined,
  );
}

function expectToolOutputs(
  controller: SessionController,
  outputs: readonly string[],
): void {
  expect(controller.state.toolStreams.map(({ stdout }) => stdout)).toEqual(
    outputs,
  );
}

function streamBatch(): RealtimeStreamBatch {
  return {
    type: "stream_batch",
    updates: [
      {
        content: "batched model output",
        sessionId: TEST_SESSION_DETAIL.id,
        streamId: "stream-batch",
        thinking: "",
        type: "session_delta",
      },
      ...EXPECTED_TOOL_OUTPUTS.map(
        (stdout, index) =>
          ({
            entry: streamEntry(index, stdout),
            terminal: false,
            type: "tool_update",
          }) as const,
      ),
    ],
  };
}

function historicalController(): {
  readonly controller: SessionController;
  readonly detail: typeof TEST_SESSION_DETAIL;
} {
  const detail = { ...TEST_SESSION_DETAIL, hasOlderSegments: true };
  const command = vi.fn((operation: string) => {
    const result = operation === "sessions.read" ? detail : historicalPage;
    return Promise.resolve(result);
  });
  return {
    controller: new SessionController(undefined, undefined, undefined, {
      command,
    }),
    detail,
  };
}

async function historicalSelection(): Promise<{
  readonly controller: SessionController;
  readonly detail: typeof TEST_SESSION_DETAIL;
}> {
  const selection = historicalController();
  await selection.controller.select(selection.detail.id);
  await selection.controller.olderHistory();
  return selection;
}

test("a mixed barrier batch reconciles the selected view once", () => {
  const detail: typeof TEST_SESSION_DETAIL = {
    ...TEST_SESSION_DETAIL,
    status: "running",
  };
  const state = initialSessionViewState();
  const reactive = createReactiveState<SessionViewState>(
    Object.assign(state, {
      detail,
      selectedId: TEST_SESSION_DETAIL.id,
    }),
  );
  let patches = 0;
  const controller = new SessionController(
    {
      setState(updater) {
        patches += 1;
        reactive.setState(updater);
      },
      state: reactive.state,
    },
    undefined,
    undefined,
  );
  patches = 0;

  controller.applyStreamBatch(streamBatch());

  expect(patches).toBe(1);
  const streamed = controller.state.detail?.messages.at(-1);
  expect(streamed?.content).toBe("batched model output");
  expect(streamed?.role).toBe("assistant");
  expectToolOutputs(controller, EXPECTED_TOOL_OUTPUTS);
});

test.each(STREAM_MUTATION_CASES)(
  "freezes model, tool, and snapshot streams during $name mutations",
  ({ state }) => {
    const controller = selectedController(
      { ...TEST_SESSION_DETAIL, status: "running" },
      state,
    );

    controller.applyStreamBatch(streamBatch());
    controller.applyToolDelta({
      callId: "direct-tool",
      index: 2,
      sequence: 0,
      sessionId: TEST_SESSION_DETAIL.id,
      state: "preparing",
      streamId: "stream-batch",
      type: "tool_stream",
    });
    controller.applyToolSnapshot({
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "stream-batch",
      streams: [streamEntry(0, "snapshot output")],
      type: "tool_stream_snapshot",
    });

    expect(controller.state.detail?.messages).toEqual([]);
    expect(controller.state.toolStreams).toEqual([]);
  },
);

test("ignores buffered tool updates after a terminal session snapshot", () => {
  const controller = selectedController({
    ...TEST_SESSION_DETAIL,
    status: "idle",
  });

  controller.applyStreamBatch(streamBatch());

  const terminalMessages = controller.state.detail?.messages;
  const terminalTools = controller.state.toolStreams;
  expect({ terminalMessages, terminalTools }).toEqual({
    terminalMessages: [],
    terminalTools: [],
  });
});

test("clears visible tool activity when the session becomes terminal", () => {
  const running = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const controller = selectedController(running);
  controller.applyStreamBatch(streamBatch());
  expect(controller.state.toolStreams).toHaveLength(
    EXPECTED_TOOL_OUTPUTS.length,
  );

  controller.applyDetail({ ...running, status: "idle" });

  expectToolOutputs(controller, []);
});

test("tool snapshots only replace their own stream", () => {
  const controller = selectedController({
    ...TEST_SESSION_DETAIL,
    status: "running",
  });
  controller.applyStreamBatch(streamBatch());
  const snapshot = {
    sessionId: TEST_SESSION_DETAIL.id,
    streams: [],
    type: "tool_stream_snapshot" as const,
  };

  controller.applyToolSnapshot({ ...snapshot, streamId: "previous-stream" });
  expectToolOutputs(controller, EXPECTED_TOOL_OUTPUTS);

  const beforeNoop = controller.state.toolStreams;
  controller.applyToolSnapshot({ ...snapshot, streamId: "previous-stream" });
  expect(controller.state.toolStreams).toBe(beforeNoop);

  controller.applyToolSnapshot({ ...snapshot, streamId: "stream-batch" });
  expectToolOutputs(controller, []);
});

test("historical transcript pages ignore buffered live stream batches", async () => {
  const { controller, detail } = await historicalSelection();

  controller.applyStreamBatch(streamBatch());

  expect(controller.state.detail?.messages).toEqual(detail.messages);
  expect(controller.state.toolStreams).toEqual([]);
  expect(controller.state.history.page).toEqual(historicalPage);
});

test("historical transcript pages stay separate from live snapshots", async () => {
  const { controller, detail } = await historicalSelection();

  expect(controller.state.history.page).toEqual(historicalPage);
  const liveMessage = historicalPage.messages[0];
  if (liveMessage === undefined) {
    throw new Error("The history fixture has no message");
  }
  controller.applyDetail({
    ...detail,
    messages: [
      {
        ...liveMessage,
        content: "Newest live message",
        id: "live-message",
      },
    ],
    updatedAt: detail.updatedAt + 1,
  });
  expect(controller.state.history.page).toEqual(historicalPage);
  expect(controller.state.detail?.messages[0]?.id).toBe("live-message");

  await controller.newerHistory();
  expect(controller.state.history.page).toBeUndefined();
  expect(controller.state.history.canGoOlder).toBe(true);
});
