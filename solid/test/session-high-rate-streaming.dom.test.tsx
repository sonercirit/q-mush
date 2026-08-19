import { createEffect, createRoot } from "solid-js";
import { afterEach, expect, test } from "vitest";
import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { RealtimeClientEvent } from "../realtime-stream-buffer.ts";
import type { SessionController } from "../session-controller.ts";
import { streamingRealtimeFixture } from "./realtime-stream-test-fixture.ts";
import {
  installResponseFetch,
  mountTestSessionDetail,
  type MountedTestSession,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

const TEST_NAVIGATION_SESSION = {
  ...TEST_SESSION_DETAIL,
  id: "session-navigation-target",
};
const disposals: (() => void)[] = [];

interface HighRateFixture extends MountedTestSession {
  readonly appliedBatches: () => number;
  readonly appliedStreamEvents: () => number;
  readonly stream: ReturnType<typeof streamingRealtimeFixture>;
}

function applyRealtimeEvent(
  controller: SessionController,
  event: RealtimeClientEvent,
): void {
  if (event.type === "stream_batch") controller.applyStreamBatch(event);
}

function trackedRealtimeListener(
  controller: SessionController,
  onBatch: (size: number) => void,
): (event: RealtimeClientEvent) => void {
  return (event) => {
    if (event.type === "stream_batch") onBatch(event.updates.length);
    applyRealtimeEvent(controller, event);
  };
}

function highRateFixture(): HighRateFixture {
  const detail = runningSessionDetail([]);
  const mounted = mountTestSessionDetail(detail, disposals);
  let appliedBatches = 0;
  let appliedStreamEvents = 0;
  const stream = streamingRealtimeFixture(
    "high-rate-instance",
    trackedRealtimeListener(mounted.controller, (size) => {
      appliedBatches += 1;
      appliedStreamEvents += size;
    }),
  );
  disposals.push(stream.stop);
  return {
    ...mounted,
    appliedBatches: () => appliedBatches,
    appliedStreamEvents: () => appliedStreamEvents,
    stream,
  };
}

function modelDelta(
  sequence: number,
): Extract<RealtimeServerEvent, { type: "session_delta" }> {
  return {
    content: `model-${String(sequence)};`,
    sessionId: "session-1",
    streamId: "high-rate-step",
    thinking: `thinking-${String(sequence)};`,
    type: "session_delta",
  };
}

function toolDelta(
  sequence: number,
): Extract<RealtimeServerEvent, { type: "tool_stream" }> {
  const initial = {
    callId: "high-rate-call",
    index: 0,
    sequence,
    sessionId: "session-1",
    streamId: "high-rate-step",
    type: "tool_stream" as const,
  };
  if (sequence === 0) {
    return { ...initial, state: "preparing" };
  }
  if (sequence === 1) {
    return { ...initial, state: "running" };
  }
  return {
    ...initial,
    channel: "stdout",
    content: `tool-${String(sequence)};`,
  };
}

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});

function createViewUpdateCounter(controller: SessionController): {
  readonly count: () => number;
  readonly increment: () => void;
  readonly reset: () => void;
} {
  let updates = 0;
  return {
    count: () => updates,
    increment: () => {
      controller.view();
      updates += 1;
    },
    reset: () => {
      updates = 0;
    },
  };
}

function trackViewUpdates(
  controller: SessionController,
  disposals: (() => void)[],
): { readonly count: () => number; readonly reset: () => void } {
  const counter = createViewUpdateCounter(controller);
  disposals.push(
    createRoot((dispose) => {
      createEffect(counter.increment);
      return dispose;
    }),
  );
  return counter;
}

interface StreamMeasurements {
  readonly batches: number;
  readonly events: number;
  readonly viewUpdates: number;
}

function expectStreamMeasurements(
  fixture: HighRateFixture,
  viewUpdates: number,
  expected: StreamMeasurements,
): void {
  const actual = {
    batches: fixture.appliedBatches(),
    events: fixture.appliedStreamEvents(),
    viewUpdates,
  };
  expect(actual).toEqual(expected);
}

function applyNextStreamFrame(
  fixture: HighRateFixture,
  trackedView: { readonly count: () => number },
  expected: StreamMeasurements,
): void {
  fixture.stream.pendingFrames.shift()?.();
  expectStreamMeasurements(fixture, trackedView.count(), expected);
}

test("high-rate model and tool streams apply one bounded view update per frame", async () => {
  installResponseFetch(TEST_NAVIGATION_SESSION, disposals);
  const fixture = highRateFixture();
  const prompt = fixture.container.querySelector<HTMLTextAreaElement>(
    "[data-session-composer='true'] textarea[name='prompt']",
  );
  if (prompt === null) throw new TypeError("Missing session composer");
  const trackedView = trackViewUpdates(fixture.controller, disposals);
  trackedView.reset();

  const streamUpdates = 200;
  for (let sequence = 0; sequence < streamUpdates; sequence += 1) {
    fixture.stream.receive(modelDelta(sequence));
    fixture.stream.receive(toolDelta(sequence));
  }

  expect(fixture.stream.pendingFrames).toHaveLength(1);
  expectStreamMeasurements(fixture, trackedView.count(), {
    batches: 0,
    events: 0,
    viewUpdates: 0,
  });
  applyNextStreamFrame(fixture, trackedView, {
    batches: 1,
    events: 2,
    viewUpdates: 1,
  });
  expect(fixture.stream.pendingFrames).toHaveLength(0);
  const modelContent = fixture.controller.state.detail?.messages.at(-1);
  const tool = fixture.controller.state.toolStreams[0];
  expect(modelContent?.content).toBe(
    Array.from(
      { length: streamUpdates },
      (_, sequence) => `model-${String(sequence)};`,
    ).join(""),
  );
  expect(tool?.stdout).toBe(
    Array.from(
      { length: streamUpdates - 2 },
      (_, index) => `tool-${String(index + 2)};`,
    ).join(""),
  );
  expect(fixture.stream.pendingFrames).toHaveLength(0);

  prompt.value = "still interactive";
  prompt.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(prompt.value).toBe("still interactive");

  fixture.stream.receive(modelDelta(streamUpdates));
  fixture.stream.receive(toolDelta(streamUpdates));
  expect(fixture.stream.pendingFrames).toHaveLength(1);
  const selection = fixture.controller.select(TEST_NAVIGATION_SESSION.id);
  await selection;
  expect(fixture.controller.state).toMatchObject({
    detail: { id: TEST_NAVIGATION_SESSION.id, messages: [] },
    selectedId: TEST_NAVIGATION_SESSION.id,
  });
  const selectedDetail = fixture.controller.state.detail;
  fixture.stream.pendingFrames.shift()?.();
  expect(fixture.controller.state.detail).toBe(selectedDetail);
  expect(fixture.appliedBatches()).toBe(2);
});
