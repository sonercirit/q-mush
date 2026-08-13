import { afterEach, expect, test, vi } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionList } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import {
  disposeTestViews,
  mountTestView,
  useFakeTestClock,
} from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function useFakeClock(startMs: number): void {
  useFakeTestClock(disposals);
  vi.setSystemTime(new Date(startMs));
}

afterEach(() => {
  disposeTestViews(disposals);
});

function sessionTimeText(container: ParentNode): string {
  const text = [...container.querySelectorAll("span")].find(
    ({ textContent }) =>
      textContent.startsWith("Time: ") && !textContent.includes("Cost:"),
  )?.textContent;
  if (text === undefined) {
    throw new Error("The session time was not rendered");
  }
  return text;
}

function runDurationText(container: ParentNode): string | undefined {
  return (
    container.querySelector("[data-session-run-duration='true']")
      ?.textContent ?? undefined
  );
}

function stepDurationText(container: ParentNode): string | undefined {
  return (
    container.querySelector("[data-session-step-duration='true']")
      ?.textContent ?? undefined
  );
}

function mountQueuedSession(startMs: number) {
  useFakeClock(startMs);
  const queued = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  return { queued, ...mountTestSessionDetail(queued, disposals) };
}

test("a mounted session timer starts when the session begins running", () => {
  const { container, controller, queued } = mountQueuedSession(10_000);

  expect(sessionTimeText(container)).toBe("Time: 0s");
  controller.applyDetail({
    ...queued,
    activeStartedAt: Date.now(),
    status: "running",
    updatedAt: queued.updatedAt + 1,
  });
  vi.advanceTimersByTime(2_000);

  expect(sessionTimeText(container)).toBe("Time: 2s");
  expect(runDurationText(container)).toBe("Run: 2s");
});

test("a running session shows and ticks its current step duration", () => {
  const { container, controller, queued } = mountQueuedSession(20_000);

  expect(stepDurationText(container)).toBeUndefined();

  const running = {
    ...queued,
    activeStartedAt: Date.now(),
    status: "running" as const,
    stepStartedAt: Date.now(),
    updatedAt: queued.updatedAt + 1,
  };
  controller.applyDetail(running);
  vi.advanceTimersByTime(3_000);

  expect(stepDurationText(container)).toBe("Step: 3s");

  // A later model step resets the visible step clock below the run clock.
  controller.applyDetail({
    ...running,
    stepStartedAt: Date.now(),
    updatedAt: running.updatedAt + 1,
  });
  vi.advanceTimersByTime(1_000);

  expect(stepDurationText(container)).toBe("Step: 1s");
  expect(runDurationText(container)).toBe("Run: 4s");

  // A stale step timestamp without an active run must render nothing.
  controller.applyDetail({
    ...running,
    activeStartedAt: null,
    status: "idle",
    stepStartedAt: Date.now(),
    updatedAt: running.updatedAt + 2,
  });

  expect(stepDurationText(container)).toBeUndefined();
  expect(runDurationText(container)).toBeUndefined();
});

test("a retained sidebar row keeps ticking its run duration", () => {
  useFakeClock(50_000);
  const running = {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    activeStartedAt: Date.now(),
    status: "running" as const,
  };
  const other = {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: "session-other",
    title: "Other session",
  };
  const state = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [running, other],
  });
  const controller = new SessionController(state);
  const container = mountTestView(
    () => <SessionList controller={controller} />,
    disposals,
  );
  const runLabel = () => runDurationText(container);
  const initialRow = container.querySelector(
    `[data-session-id='${running.id}']`,
  );
  expect(runLabel()).toBe("Run: 0s");

  vi.advanceTimersByTime(2_000);
  controller.applyRealtime([
    running,
    { ...other, title: "Renamed", updatedAt: other.updatedAt + 1 },
  ]);
  vi.advanceTimersByTime(1_000);

  expect(container.querySelector(`[data-session-id='${running.id}']`)).toBe(
    initialRow,
  );
  expect(runLabel()).toBe("Run: 3s");

  // A step-start change alone must replace the retained row so the Step
  // timer rebases; summaryFromDetail must carry the field for that to work.
  const stepped = {
    ...summaryFromDetail({ ...TEST_SESSION_DETAIL, stepStartedAt: 52_000 }),
    activeStartedAt: running.activeStartedAt,
    status: "running" as const,
  };
  expect(stepped.stepStartedAt).toBe(52_000);
  controller.applyRealtime([stepped, other]);
  expect(stepDurationText(container)).toBe("Step: 1s");

  controller.applyRealtime([
    { ...stepped, activeStartedAt: null, status: "idle" as const },
    other,
  ]);
  expect(runLabel()).toBeUndefined();
});
