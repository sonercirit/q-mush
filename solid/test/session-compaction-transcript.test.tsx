import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { createDisplaySessionMessage } from "../../solid/session-message.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../../solid/session-transcript-filters.ts";
import { SessionTranscript } from "../../solid/session-transcript.tsx";
import { installFetch } from "./controller-test-helpers.ts";
import { renderSolidToString } from "./render-solid.tsx";
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

const COMPACTION_REQUEST = "Create the handoff summary.";
const COMPACTION_STREAM_ID = "compaction-step";

function compactionDetail(sessionId: string): AgentSessionDetail {
  return sessionDetailWithStatus(
    "running",
    [transcriptMessage("old-user", "Original request", "user", 1)],
    sessionId,
  );
}

function applyCompactionRequest(
  controller: SessionController,
  sessionId: string,
): void {
  controller.applyCompactionRequest({
    content: COMPACTION_REQUEST,
    sessionId,
    streamId: COMPACTION_STREAM_ID,
    type: "session_compaction_request",
  });
}

interface SelectedCompactionController {
  readonly controller: SessionController;
  readonly detail: AgentSessionDetail;
}

async function selectedCompactionController(
  sessionId: string,
): Promise<SelectedCompactionController> {
  const detail = compactionDetail(sessionId);
  const controller = await selectedController(detail);
  applyCompactionRequest(controller, sessionId);
  return { controller, detail };
}

function applyCompactionDelta(
  controller: SessionController,
  sessionId: string,
  content: string,
  reset = false,
): void {
  const delta = {
    content,
    sessionId,
    streamId: COMPACTION_STREAM_ID,
    thinking: "",
    type: "session_delta" as const,
  };
  controller.applyDelta(reset ? { ...delta, reset: true } : delta);
}

function expectCompactionMessages(
  controller: SessionController,
  assistantContent: string,
  assistantId?: string,
): void {
  expect(controller.state.detail?.messages).toMatchObject([
    { id: "old-user", role: "user" },
    {
      content: COMPACTION_REQUEST,
      id: `stream:${COMPACTION_STREAM_ID}:compaction-request`,
      role: "compaction_request",
    },
    {
      content: assistantContent,
      ...(assistantId === undefined ? {} : { id: assistantId }),
      role: "assistant",
    },
  ]);
}

function renderCompactionMessages(
  messages: readonly AgentSessionDetail["messages"][number][],
): string {
  return renderSolidToString(() => (
    <SessionTranscript
      executionEnvironment="bare_metal"
      filters={DEFAULT_SESSION_TRANSCRIPT_FILTERS}
      messages={messages}
      agentFile={null}
      tools={[]}
    />
  ));
}

test("renders a compaction request before its streamed response", () => {
  const html = renderCompactionMessages([
    createDisplaySessionMessage({
      content: "Compact this conversation into a handoff.",
      createdAt: 1,
      id: "stream:compaction-step:compaction-request",
      role: "compaction_request",
    }),
    transcriptMessage(
      "stream:session-1:assistant",
      "Summary in progress",
      "assistant",
      2,
    ),
  ]);

  expect(html).toContain("Compaction request");
  expect(
    html.indexOf("Compact this conversation into a handoff."),
  ).toBeLessThan(html.indexOf("Summary in progress"));
});

test("keeps the streamed compaction request across a provider reset", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "session-compaction-reset";
  const { controller } = await selectedCompactionController(sessionId);

  try {
    applyCompactionDelta(controller, sessionId, "Discarded partial response");
    applyCompactionDelta(controller, sessionId, "Replacement ", true);
    applyCompactionDelta(controller, sessionId, "response");

    expectCompactionMessages(controller, "Replacement response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const SNAPSHOT_TIMINGS = ["delta-first", "snapshot-first"] as const;

test.each(SNAPSHOT_TIMINGS)(
  "anchors one streamed compaction request when the snapshot is %s",
  async (snapshotTiming) => {
    const originalFetch = globalThis.fetch;
    const sessionId = "session-compaction-stream";
    const { controller, detail } =
      await selectedCompactionController(sessionId);

    try {
      const compactionRequests = () =>
        controller.state.detail?.messages.filter(
          ({ role }) => role === "compaction_request",
        ) ?? [];
      const requestCounts = [compactionRequests().length];

      if (snapshotTiming === "snapshot-first") {
        controller.applyDetail(detail);
        requestCounts.push(compactionRequests().length);
      }

      for (const content of ["Compacted ", "response"]) {
        applyCompactionDelta(controller, sessionId, content);
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

      expect(requestCounts).toEqual(
        Array.from({ length: requestCounts.length }, () => 1),
      );
      expect(compactionRequests().map(({ id }) => id)).toEqual([
        "stream:compaction-step:compaction-request",
      ]);
      expectCompactionMessages(
        controller,
        "Compacted response",
        "settled-summary",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
