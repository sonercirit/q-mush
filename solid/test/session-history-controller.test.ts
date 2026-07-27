import { expect, test, vi } from "vitest";
import { TEST_SESSION_DETAIL } from "../../shared/test/session-fixtures.ts";
import { SessionController } from "../../solid/session-controller.ts";

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

test("historical transcript pages stay separate from live snapshots", async () => {
  const detail = { ...TEST_SESSION_DETAIL, hasOlderSegments: true };
  const command = vi.fn((operation: string) =>
    Promise.resolve(operation === "sessions.read" ? detail : historicalPage),
  );
  const controller = new SessionController(undefined, undefined, undefined, {
    command,
  });
  await controller.select(detail.id);
  await controller.olderHistory();

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
