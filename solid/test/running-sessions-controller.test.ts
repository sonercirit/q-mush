import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import { RunningSessionsController } from "../running-sessions-controller.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { countReactiveChanges } from "./controller-test-helpers.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function sessionSummary(
  id: string,
  status: AgentSessionStatus,
  updatedAt: number,
): AgentSessionSummary {
  return {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    activeStartedAt: status === "running" ? 1_000 : null,
    id,
    status,
    title: `Task ${id}`,
    updatedAt,
  };
}

function overview(controller: RunningSessionsController) {
  const current = controller.state.overview;
  if (current === undefined) {
    throw new Error("The running-sessions overview was not initialized");
  }
  return current;
}

function visibleIds(controller: RunningSessionsController): readonly string[] {
  return overview(controller).visibleSessions.map(({ id }) => id);
}

test("derives bounded active-session counts in deterministic useful order", () => {
  const controller = createRoot(() => new RunningSessionsController());
  controller.applySnapshot([
    sessionSummary("queued-new", "queued", 9),
    sessionSummary("idle", "idle", 20),
    sessionSummary("running-old", "running", 3),
    sessionSummary("failed", "failed", 19),
    sessionSummary("running-new", "running", 8),
    sessionSummary("queued-old", "queued", 2),
    sessionSummary("running-middle", "running", 6),
    sessionSummary("stopped", "stopped", 18),
  ]);
  const derived = overview(controller);
  expect(derived).toMatchObject({
    overflowCount: 1,
    queuedCount: 2,
    runningCount: 3,
  });
  expect(derived.visibleSessions.map(({ id }) => id)).toEqual([
    "running-new",
    "running-middle",
    "running-old",
    "queued-new",
  ]);

  controller.applySnapshot([
    sessionSummary("running-a", "running", 10),
    sessionSummary("running-c", "running", 10),
    sessionSummary("running-b", "running", 10),
  ]);
  expect(visibleIds(controller)).toEqual([
    "running-c",
    "running-b",
    "running-a",
  ]);
});

test("stores only an authoritative bounded overview through its lifecycle", () => {
  const controller = createRoot(() => new RunningSessionsController());
  expect(controller.state).toEqual({
    freshness: "loading",
    overview: undefined,
  });

  expect(controller.state.overview).toBeUndefined();
  const hundred = Array.from({ length: 100 }, (_, index) =>
    sessionSummary(`running-${String(index)}`, "running", index),
  );
  controller.applySnapshot(hundred);
  expect(overview(controller)).toMatchObject({
    overflowCount: 96,
    runningCount: 100,
  });
  expect(overview(controller).visibleSessions).toHaveLength(4);

  const queued = sessionSummary("owned-session", "queued", 101);
  controller.applySnapshot([queued]);
  expect(overview(controller)).toMatchObject({
    queuedCount: 1,
    runningCount: 0,
  });
  const running = sessionSummary("owned-session", "running", 102);
  const spawned = sessionSummary("spawned-session", "running", 103);
  controller.applySnapshot([running, spawned]);
  expect(overview(controller).runningCount).toBe(2);

  controller.connectionLost();
  expect(controller.state.freshness).toBe("stale");
  expect(visibleIds(controller)).toEqual(["spawned-session", "owned-session"]);
  controller.applySnapshot([sessionSummary("current-session", "queued", 104)]);
  expect(controller.state.freshness).toBe("live");
  expect(visibleIds(controller)).toEqual(["current-session"]);

  controller.applySnapshot([
    sessionSummary("owned-session", "idle", 105),
    sessionSummary("spawned-session", "failed", 106),
  ]);
  expect(overview(controller)).toEqual({
    overflowCount: 0,
    queuedCount: 0,
    runningCount: 0,
    visibleSessions: [],
  });
  controller.reset();
  controller.connectionLost();
  expect(controller.state).toEqual({ freshness: "stale", overview: undefined });
});

test("retains keyed identity and skips panel-irrelevant notifications", () => {
  createRoot((dispose) => {
    const controller = new RunningSessionsController();
    const running = sessionSummary("stable-session", "running", 1);
    const notifications = countReactiveChanges(controller);

    controller.applySnapshot([running]);
    const afterSnapshot = notifications.count();
    const retained = overview(controller).visibleSessions[0];
    controller.applyDelta();
    expect(notifications.count()).toBe(afterSnapshot);

    controller.applySnapshot([
      {
        ...running,
        currentContextTokens: running.currentContextTokens + 1_000,
        updatedAt: running.updatedAt + 2,
      },
      sessionSummary("new-session", "queued", 4),
    ]);
    expect(overview(controller).visibleSessions[0]).toBe(retained);
    dispose();
  });
});
