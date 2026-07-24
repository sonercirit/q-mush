import { expect, vi } from "vitest";
import type { SessionCompactionRealtimeEvent } from "../../shared/compaction-realtime.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { SessionController } from "../session-controller.ts";
import { createResponseFetch } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

export function runningCompactionDetail(sessionId: string): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, id: sessionId, status: "running" };
}

export function sessionCompactionEvent(
  phase: SessionCompactionRealtimeEvent["phase"],
  sequence: number,
  options: {
    readonly attempt?: number;
    readonly operationId?: string;
    readonly reasoning?: string;
    readonly sessionId?: string;
    readonly summary?: string;
  } = {},
): SessionCompactionRealtimeEvent {
  const base = {
    attempt: options.attempt ?? 0,
    operationId: options.operationId ?? "operation-1",
    sequence,
    sessionId: options.sessionId ?? TEST_SESSION_DETAIL.id,
    type: "session_compaction" as const,
  };
  return phase === "delta"
    ? {
        ...base,
        phase,
        reasoning: options.reasoning ?? "",
        summary: options.summary ?? "",
      }
    : { ...base, phase };
}

export async function selectCompactionController(
  controller: SessionController,
  detail: AgentSessionDetail,
): Promise<void> {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(createResponseFetch(detail));
  try {
    await controller.select(detail.id);
  } finally {
    fetchMock.mockRestore();
  }
}

export async function selectedCompactionController(
  detail = runningCompactionDetail(TEST_SESSION_DETAIL.id),
): Promise<SessionController> {
  const controller = new SessionController();
  await selectCompactionController(controller, detail);
  return controller;
}

export function applyCompaction(
  controller: SessionController,
  phase: SessionCompactionRealtimeEvent["phase"],
  sequence: number,
  options?: Parameters<typeof sessionCompactionEvent>[2],
): void {
  controller.applyCompaction(sessionCompactionEvent(phase, sequence, options));
}

export function applyCompactionEvents(
  controller: SessionController,
  ...events: readonly SessionCompactionRealtimeEvent[]
): void {
  for (const event of events) {
    controller.applyCompaction(event);
  }
}

export async function startedCompactionController(): Promise<SessionController> {
  const controller = await selectedCompactionController();
  applyCompaction(controller, "start", 0);
  return controller;
}

export function expectNoCompactionPreview(controller: SessionController): void {
  expect(controller.state.compactionPreview).toBeUndefined();
}
