import { afterEach, expect, test, vi } from "vitest";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionList } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { disposeTestViews, mountTestView } from "./dom-test-helpers.ts";
import { mountTestSessionDetail } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function useFakeClock(startMs: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(startMs));
  disposals.push(() => {
    vi.useRealTimers();
  });
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

test("a mounted session timer starts when the session begins running", () => {
  useFakeClock(10_000);
  const queued = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  const { container, controller } = mountTestSessionDetail(queued, disposals);

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

  controller.applyRealtime([
    { ...running, activeStartedAt: null, status: "idle" as const },
    other,
  ]);
  expect(runLabel()).toBeUndefined();
});
