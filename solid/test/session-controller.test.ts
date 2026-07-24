import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import { summaryFromDetail } from "../../solid/session-codec.ts";
import { SessionController } from "../../solid/session-controller.ts";
import {
  expectRealtimeToRemainSilent,
  requestUrl,
} from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { testToolStreamEntry } from "./tool-stream-fixtures.ts";

function mountedController(): {
  readonly controller: SessionController;
  readonly restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(sessionResponse, {
    preconnect: originalFetch.preconnect,
  });
  return {
    controller: createRoot(() => new SessionController()),
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function toolDelta(
  common: Readonly<{
    callId: string;
    index: number;
    sessionId: string;
    streamId: string;
    type: "tool_stream";
  }>,
  sequence: number,
  channel: "name" | "stdout",
  content: string,
) {
  return { ...common, channel, content, sequence };
}

function sessionResponse(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(requestUrl(input), "http://localhost").pathname;
  return Promise.resolve(
    Response.json(
      path === SESSIONS_PATH
        ? { sessions: [summaryFromDetail(TEST_SESSION_DETAIL)] }
        : TEST_SESSION_DETAIL,
    ),
  );
}

function createLoadedController(): {
  readonly controller: SessionController;
  readonly restore: () => void;
} {
  return mountedController();
}

test("renders incremental model deltas in the selected transcript", async () => {
  const { controller, restore } = mountedController();

  try {
    await controller.load();
    expect(controller.state.draft.workingDirectory).toBe(
      TEST_SESSION_DETAIL.workingDirectory,
    );
    controller.applyDelta({
      content: "Hello",
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "stream-1",
      thinking: "Considering",
      type: "session_delta",
    });
    controller.applyDelta({
      content: " world",
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "stream-1",
      thinking: " carefully",
      type: "session_delta",
    });

    controller.applyDelta({
      content: "",
      reset: true,
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: ["stream", "1"].join("-"),
      thinking: "",
      type: "session_delta",
    });

    expect(controller.state.detail?.messages).toEqual([]);

    controller.applyDelta({
      content: "Replacement",
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "stream-1",
      thinking: "Reconsidering",
      type: "session_delta",
    });

    expect(controller.state.detail?.messages.slice(-2)).toMatchObject([
      { content: "Reconsidering", role: "thinking" },
      { content: "Replacement", role: "assistant" },
    ]);

    const errorMessage = {
      content: "Session failed: the provider connection was lost",
      createdAt: 3,
      id: "error-1",
      images: [],
      role: "error" as const,
      toolCallId: null,
      toolCalls: [],
      toolName: null,
    };
    controller.applyDetail({
      ...TEST_SESSION_DETAIL,
      messages: [errorMessage],
      status: "failed",
      updatedAt: 3,
    });
    expect(controller.state.detail?.messages).toEqual([errorMessage]);
  } finally {
    restore();
  }
});

test("orders and reconciles live tool calls independently", async () => {
  const { controller, restore } = createLoadedController();

  try {
    await controller.load();
    const common = {
      callId: "call-1",
      index: 0,
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "turn-1",
      type: "tool_stream" as const,
    };
    controller.applyToolDelta({ ...common, sequence: 0, state: "preparing" });
    controller.applyToolDelta(toolDelta(common, 2, "name", "read"));
    expect(controller.state.toolStreams[0]?.name).toBe("");
    controller.applyToolDelta(toolDelta(common, 1, "name", "read"));
    controller.applyToolDelta(toolDelta(common, 1, "stdout", "late duplicate"));
    expect(controller.state.toolStreams[0]).toMatchObject({
      name: "read",
      sequence: 1,
      stdout: "",
    });

    controller.applyToolDelta({
      ...toolDelta(common, 2, "stdout", "coalesced"),
      sequenceStart: 2,
    });
    const coalesced = controller.state.toolStreams[0];
    expect(coalesced?.sequence).toBe(2);
    expect(coalesced?.stdout).toBe("coalesced");

    controller.applyToolSnapshot({
      sessionId: TEST_SESSION_DETAIL.id,
      streamId: "turn-1",
      streams: [testToolStreamEntry(TEST_SESSION_DETAIL.id)],
      type: "tool_stream_snapshot",
    });
    expect(controller.state.toolStreams[0]).toMatchObject({
      sequence: 3,
      stdout: "snapshot",
    });
  } finally {
    restore();
  }
});

test("an unchanged session refresh does not notify the view", async () => {
  await expectRealtimeToRemainSilent(
    () => new SessionController(),
    sessionResponse,
    [summaryFromDetail(TEST_SESSION_DETAIL)],
  );
});
