import { expect, test } from "vitest";
import { SessionController } from "../session-controller.ts";
import { createResponseFetch } from "./session-dom-test-helpers.tsx";
import {
  sessionDetailWithStatus,
  sessionMessageIds,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

test("retains the rendered stream when a batch fills the background LRU", async () => {
  const selected = sessionDetailWithStatus(
    "running",
    [transcriptMessage("selected-user", "Selected request", "user", 1)],
    "session-selected",
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createResponseFetch(selected);

  try {
    const controller = new SessionController();
    const selection = controller.select(selected.id);
    await selection;
    controller.applyStreamBatch({
      type: "stream_batch",
      updates: [
        {
          content: "Selected live",
          sessionId: selected.id,
          thinking: "",
          type: "session_delta",
        },
        ...Array.from({ length: 100 }, (_, index) => ({
          content: `Background ${String(index)}`,
          sessionId: `session-background-${String(index)}`,
          thinking: "",
          type: "session_delta" as const,
        })),
      ],
    });

    const renderedMessageIds = [
      "selected-user",
      `stream:${selected.id}:assistant`,
    ];
    expect(sessionMessageIds(controller)).toEqual(renderedMessageIds);
    controller.applyDetail(selected);
    expect(sessionMessageIds(controller)).toEqual(renderedMessageIds);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
