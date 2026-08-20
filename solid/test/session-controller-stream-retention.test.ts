import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../session-controller.ts";
import { identifiedModelDelta } from "./realtime-stream-event-fixtures.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  sessionDetailWithStatus,
  sessionMessageIds,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

function streamBatch(sessionId: string) {
  return {
    type: "stream_batch" as const,
    updates: [
      {
        content: "Selected live",
        sessionId,
        thinking: "",
        type: "session_delta" as const,
      },
      ...Array.from({ length: 100 }, (_, index) => ({
        content: `Background ${String(index)}`,
        sessionId: `session-background-${String(index)}`,
        thinking: "",
        type: "session_delta" as const,
      })),
    ],
  };
}

function detail(id: string): AgentSessionDetail {
  return sessionDetailWithStatus(
    "running",
    [transcriptMessage(`${id}-user`, "Selected request", "user", 1)],
    id,
  );
}

function expectedMessageIds(sessionId: string): readonly string[] {
  return [`${sessionId}-user`, `stream:${sessionId}:assistant`];
}

test("retains the selected stream while its detail fetch is pending", async () => {
  const selected = detail("session-selected");
  const originalFetch = globalThis.fetch;
  let resolveFetch: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    () =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    { preconnect: originalFetch.preconnect },
  );

  try {
    const controller = new SessionController();
    const selection = controller.select(selected.id);
    expect(resolveFetch).toBeTypeOf("function");
    controller.applyStreamBatch(streamBatch(selected.id));

    resolveFetch?.(Response.json(selected));
    await selection;
    controller.applyDetail(selected);

    expect(sessionMessageIds(controller)).toEqual(
      expectedMessageIds(selected.id),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retains a rendered stale detail stream during navigation", () => {
  const rendered = detail("session-rendered");
  const destination = detail("session-destination");
  const reactive = sessionDetailState(rendered);
  reactive.setState((view) => ({ ...view, selectedId: destination.id }));
  const controller = new SessionController(reactive);
  controller.applyStreamBatch(streamBatch(rendered.id));
  reactive.setState((view) => ({ ...view, selectedId: rendered.id }));
  controller.applyDetail(rendered);

  expect(sessionMessageIds(controller)).toEqual(
    expectedMessageIds(rendered.id),
  );
});

test("bounds frozen mutation rebases while retaining visible sessions", () => {
  const selected = detail("session-selected");
  const reactive = sessionDetailState(selected);
  const controller = new SessionController(reactive);
  const oldest = detail("session-frozen-0");
  reactive.setState((view) => ({
    ...view,
    detail: oldest,
    selectedId: oldest.id,
  }));
  controller.applyStreamBatch({
    type: "stream_batch",
    updates: [
      {
        content: "retained live output",
        sessionId: oldest.id,
        thinking: "",
        type: "session_delta",
      },
    ],
  });
  reactive.setState((view) => ({
    ...view,
    detail: selected,
    selectedId: selected.id,
  }));
  reactive.setState((view) => ({ ...view, sending: true }));
  controller.applyStreamBatch({
    type: "stream_batch",
    updates: Array.from({ length: 101 }, (_, index) =>
      identifiedModelDelta(
        `session-frozen-${String(index)}`,
        `stream-frozen-${String(index)}`,
        "frozen",
      ),
    ),
  });
  reactive.setState((view) => ({ ...view, sending: false }));

  reactive.setState((view) => ({ ...view, selectedId: oldest.id }));
  controller.applyDetail(oldest);

  expect(sessionMessageIds(controller)).toEqual(expectedMessageIds(oldest.id));
});
