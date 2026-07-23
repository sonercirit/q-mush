import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type {
  AgentSessionStatus,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import {
  deriveRunningSessions,
  RunningSessionsController,
} from "../running-sessions-controller.ts";
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

test("derives explicit running and queued counts with a bounded useful list", () => {
  const sessions = [
    sessionSummary("queued-new", "queued", 9),
    sessionSummary("idle", "idle", 20),
    sessionSummary("running-old", "running", 3),
    sessionSummary("failed", "failed", 19),
    sessionSummary("running-new", "running", 8),
    sessionSummary("queued-old", "queued", 2),
    sessionSummary("running-middle", "running", 6),
    sessionSummary("stopped", "stopped", 18),
  ];

  const overview = deriveRunningSessions(sessions, 4);

  expect(overview).toMatchObject({
    overflowCount: 1,
    queuedCount: 2,
    runningCount: 3,
  });
  expect(overview.visibleSessions.map(({ id }) => id)).toEqual([
    "running-new",
    "running-middle",
    "running-old",
    "queued-new",
  ]);
  expect(overview.visibleSessions).toHaveLength(4);
});

test("tracks queued, running, finished, failed, stopped, and spawned realtime events", () => {
  const controller = createRoot(() => new RunningSessionsController());
  const queued = sessionSummary("owned-session", "queued", 1);

  expect(controller.state).toEqual({
    freshness: "loading",
    sessions: undefined,
  });

  controller.applySnapshot([
    queued,
    sessionSummary("failed-session", "failed", 2),
    sessionSummary("stopped-session", "stopped", 3),
  ]);
  expect(deriveRunningSessions(controller.state.sessions ?? [])).toMatchObject({
    queuedCount: 1,
    runningCount: 0,
  });

  controller.applySession({
    ...queued,
    activeStartedAt: 2_000,
    status: "running",
    updatedAt: 4,
  });
  expect(deriveRunningSessions(controller.state.sessions ?? [])).toMatchObject({
    queuedCount: 0,
    runningCount: 1,
  });

  controller.applySession(sessionSummary("spawned-session", "running", 5));
  expect(
    deriveRunningSessions(controller.state.sessions ?? []).runningCount,
  ).toBe(2);

  controller.applySession(sessionSummary("owned-session", "idle", 6));
  controller.applySession(sessionSummary("spawned-session", "failed", 7));
  expect(controller.state.sessions).toEqual([]);
});

test("marks a disconnected snapshot stale and replaces it exactly on reconnect", () => {
  const controller = createRoot(() => new RunningSessionsController());
  controller.applySnapshot([
    sessionSummary("previous-user-session", "running", 1),
  ]);

  controller.connectionLost();
  expect(controller.state.freshness).toBe("stale");
  expect(controller.state.sessions?.map(({ id }) => id)).toEqual([
    "previous-user-session",
  ]);

  controller.applySnapshot([sessionSummary("current-session", "queued", 2)]);
  expect(controller.state).toMatchObject({ freshness: "live" });
  expect(controller.state.sessions?.map(({ id }) => id)).toEqual([
    "current-session",
  ]);

  controller.reset();
  expect(controller.state).toEqual({
    freshness: "loading",
    sessions: undefined,
  });
});

test("waits for the authoritative snapshot before accepting detail events", () => {
  const controller = createRoot(() => new RunningSessionsController());

  controller.applySession(
    sessionSummary("detail-before-snapshot", "running", 1),
  );

  expect(controller.state.sessions).toBeUndefined();
  controller.applySnapshot([]);
  expect(controller.state.sessions).toEqual([]);
});

test("marks a disconnected snapshot stale before any snapshot arrives", () => {
  const controller = createRoot(() => new RunningSessionsController());

  controller.connectionLost();

  expect(controller.state).toEqual({ freshness: "stale", sessions: undefined });
});

test("retains item identity and does not notify for panel-irrelevant session changes", () => {
  createRoot((dispose) => {
    const controller = new RunningSessionsController();
    const running = sessionSummary("stable-session", "running", 1);
    const notifications = countReactiveChanges(controller);

    controller.applySnapshot([running]);
    const afterSnapshot = notifications.count();
    const retained = controller.state.sessions?.[0];

    controller.applySession({
      ...running,
      currentContextTokens: running.currentContextTokens + 500,
      updatedAt: running.updatedAt + 1,
    });
    expect(notifications.count()).toBe(afterSnapshot);

    controller.applySnapshot([
      {
        ...running,
        currentContextTokens: running.currentContextTokens + 1_000,
        updatedAt: running.updatedAt + 2,
      },
      sessionSummary("new-session", "queued", 4),
    ]);
    expect(controller.state.sessions?.[0]).toBe(retained);
    dispose();
  });
});
