import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { installFetch } from "./controller-test-helpers.ts";
import { createResponseFetch } from "./session-dom-test-helpers.tsx";
import {
  sessionDetailWithStatus,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

async function selectedController(
  selected: AgentSessionDetail,
): Promise<SessionController> {
  installFetch(createResponseFetch(selected));
  const controller = createRoot(() => new SessionController());
  await controller.select(selected.id);
  return controller;
}

test("anchors a streamed compaction response after its visible request", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "session-compaction-stream";
  const detail = sessionDetailWithStatus(
    "running",
    [transcriptMessage("old-user", "Original request", "user", 1)],
    sessionId,
  );

  try {
    const controller = await selectedController(detail);
    controller.applyCompactionRequest({
      content: "Create the handoff summary.",
      sessionId,
      streamId: "compaction-step",
      type: "session_compaction_request",
    });
    const compactionRequests = () =>
      controller.state.detail?.messages.filter(
        ({ role }) => role === "compaction_request",
      ) ?? [];
    const requestCounts = [compactionRequests().length];

    for (const content of ["Compacted ", "response"]) {
      controller.applyDelta({
        content,
        sessionId,
        streamId: "compaction-step",
        thinking: "",
        type: "session_delta",
      });
      requestCounts.push(compactionRequests().length);
    }

    const settledSummary = transcriptMessage(
      "settled-summary",
      "Compacted response",
      "assistant",
      2,
    );
    controller.applyDetail({
      ...detail,
      messages: detail.messages.concat(settledSummary),
    });
    requestCounts.push(compactionRequests().length);

    expect(requestCounts).toEqual([1, 1, 1, 1]);
    expect(compactionRequests().map(({ id }) => id)).toEqual([
      "stream:compaction-step:compaction-request",
    ]);
    expect(controller.state.detail?.messages).toMatchObject([
      { id: "old-user", role: "user" },
      {
        content: "Create the handoff summary.",
        id: "stream:compaction-step:compaction-request",
        role: "compaction_request",
      },
      {
        content: "Compacted response",
        id: "settled-summary",
        role: "assistant",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
