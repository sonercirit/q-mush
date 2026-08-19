import { expect, test } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../session-controller.ts";
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
