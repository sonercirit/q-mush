import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../../solid/session-controller.ts";
import { createDisplaySessionMessage } from "../../solid/session-message.ts";
import { DEFAULT_SESSION_TRANSCRIPT_FILTERS } from "../../solid/session-transcript-filters.ts";
import { SessionTranscript } from "../../solid/session-transcript.tsx";
import { installFetch, withRestoredFetch } from "./controller-test-helpers.ts";
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
const COMPACTION_STREAM_ID = "attempt-1";
const REPLACEMENT_STREAM_ID = "attempt-2";

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
  streamId = COMPACTION_STREAM_ID,
): void {
  controller.applyCompaction({
    content: COMPACTION_REQUEST,
    sessionId,
    streamId,
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
  streamId = COMPACTION_STREAM_ID,
  reset = false,
): void {
  const delta = {
    content,
    sessionId,
    streamId,
    thinking: "",
    type: "session_delta" as const,
  };
  controller.applyDelta(reset ? { ...delta, reset: true } : delta);
}

function applyProductionResetSequence(
  controller: SessionController,
  sessionId: string,
): void {
  let streamId = COMPACTION_STREAM_ID;
  applyCompactionRequest(controller, sessionId, streamId);
  streamId = REPLACEMENT_STREAM_ID;
  applyCompactionDelta(controller, sessionId, "", streamId, true);
  applyCompactionDelta(controller, sessionId, "Replacement response", streamId);
}

function settleCompaction(
  controller: SessionController,
  sessionId: string,
): void {
  controller.applyCompaction({
    sessionId,
    type: "session_compaction_settled",
  });
}

function applyOrdinaryContinuation(
  controller: SessionController,
  sessionId: string,
): void {
  settleCompaction(controller, sessionId);
  applyCompactionDelta(
    controller,
    sessionId,
    "Ordinary continuation",
    "later-stream",
  );
}

function expectOrdinaryContinuation(
  controller: SessionController,
  expectedPrefix: readonly unknown[] = [],
): void {
  expect(compactionRequestIds(controller)).toEqual([]);
  expect(controller.state.detail?.messages.at(-1)).toMatchObject({
    content: "Ordinary continuation",
    role: "assistant",
  });
  if (expectedPrefix.length > 0) {
    expect(controller.state.detail?.messages).toMatchObject([
      ...expectedPrefix,
      { content: "Ordinary continuation", role: "assistant" },
    ]);
  }
}

function compactionRequestIds(
  controller: SessionController,
): readonly string[] {
  return (
    controller.state.detail?.messages
      .filter(({ role }) => role === "compaction_request")
      .map(({ id }) => id) ?? []
  );
}

const HANDOFF_MESSAGE =
  "Conversation compacted:\n\nContinue from this handoff.";

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

async function expectResetKeepsRequest(options: {
  readonly controller: SessionController;
  readonly execute: () => void;
}): Promise<void> {
  await withRestoredFetch(() => {
    options.execute();
    expectCompactionMessages(options.controller, "Replacement response");
    return Promise.resolve();
  });
}

test("keeps the compaction request when a reset gets a production-style new stream ID", async () => {
  const sessionId = "session-compaction-reset";
  const detail = compactionDetail(sessionId);
  const controller = await selectedController(detail);

  await expectResetKeepsRequest({
    controller,
    execute: () => {
      applyProductionResetSequence(controller, sessionId);
    },
  });
});

test("keeps the compaction request when a provider reset reuses the stream ID", async () => {
  const sessionId = "session-compaction-same-stream-reset";
  const { controller } = await selectedCompactionController(sessionId);

  await expectResetKeepsRequest({
    controller,
    execute: () => {
      applyCompactionDelta(controller, sessionId, "Discarded partial response");
      applyCompactionDelta(
        controller,
        sessionId,
        "",
        COMPACTION_STREAM_ID,
        true,
      );
      applyCompactionDelta(
        controller,
        sessionId,
        "Replacement response",
        COMPACTION_STREAM_ID,
      );
    },
  });
});

const SNAPSHOT_TIMINGS = ["delta-first", "snapshot-first"] as const;

test.each(SNAPSHOT_TIMINGS)(
  "settles the streamed compaction request on an active handoff snapshot when the snapshot is %s",
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

      const handoff = transcriptMessage("handoff", HANDOFF_MESSAGE, "user", 3);
      settleCompaction(controller, sessionId);
      controller.applyDetail({
        ...detail,
        hasOlderSegments: true,
        messages: [handoff],
      });
      requestCounts.push(compactionRequests().length);

      expect(requestCounts.slice(0, -1)).toEqual(
        Array.from({ length: requestCounts.length - 1 }, () => 1),
      );
      expect(requestCounts.at(-1)).toBe(0);
      expect(controller.state.detail?.messages.at(0)).toMatchObject({
        content: HANDOFF_MESSAGE,
        id: "handoff",
        role: "user",
      });

      applyOrdinaryContinuation(controller, sessionId);
      expectOrdinaryContinuation(controller, [
        { content: HANDOFF_MESSAGE, id: "handoff", role: "user" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("clears a failed compaction request without a snapshot", async () => {
  const sessionId = "session-compaction-failed";
  const { controller } = await selectedCompactionController(sessionId);
  applyCompactionDelta(controller, sessionId, "Aborted summary");

  applyOrdinaryContinuation(controller, sessionId);

  expectOrdinaryContinuation(controller);
});
