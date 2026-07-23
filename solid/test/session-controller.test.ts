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

test("renders incremental model deltas in the selected transcript", async () => {
  const controller = createRoot(() => new SessionController());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(sessionResponse, {
    preconnect: originalFetch.preconnect,
  });

  try {
    await controller.load();
    expect(controller.state.draft.workingDirectory).toBe(
      TEST_SESSION_DETAIL.workingDirectory,
    );
    controller.applyDelta({
      content: "Hello",
      sessionId: TEST_SESSION_DETAIL.id,
      thinking: "Considering",
      type: "session_delta",
    });
    controller.applyDelta({
      content: " world",
      sessionId: TEST_SESSION_DETAIL.id,
      thinking: " carefully",
      type: "session_delta",
    });

    controller.applyDelta({
      content: "",
      reset: true,
      sessionId: TEST_SESSION_DETAIL.id,
      thinking: "",
      type: "session_delta",
    });

    expect(controller.state.detail?.messages).toEqual([]);

    controller.applyDelta({
      content: "Replacement",
      sessionId: TEST_SESSION_DETAIL.id,
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
    globalThis.fetch = originalFetch;
  }
});

test("an unchanged session refresh does not notify the view", async () => {
  await expectRealtimeToRemainSilent(
    () => new SessionController(),
    sessionResponse,
    [summaryFromDetail(TEST_SESSION_DETAIL)],
  );
});
