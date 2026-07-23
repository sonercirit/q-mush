import { expect, test, vi } from "vitest";
import {
  deriveRunningSessions,
  RunningSessionsController,
  type RunningSessionsViewState,
} from "../running-sessions-controller.ts";
import { RunningSessionsPanel } from "../running-sessions-panel.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { renderSolidToString } from "./render-solid.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

function panelState(
  freshness: RunningSessionsViewState["freshness"],
  statuses: readonly ("queued" | "running")[],
): RunningSessionsViewState {
  return {
    freshness,
    sessions: statuses.map((status, index) => ({
      ...summaryFromDetail(TEST_SESSION_DETAIL),
      activeDurationMs: index * 1_000,
      activeStartedAt: null,
      id: `active-${String(index + 1)}`,
      model: index === 0 ? "gpt-5-codex" : "gpt-4.1-mini",
      runnerId: index === 0 ? "runner-1" : "runner-2",
      status,
      title: `Active task ${String(index + 1)}`,
      updatedAt: statuses.length - index,
    })),
  };
}

function renderPanel(state: RunningSessionsViewState): string {
  const controller = new RunningSessionsController(state);
  return renderSolidToString(() => (
    <RunningSessionsPanel
      controller={controller}
      focusSessionList={() => undefined}
      selectSession={() => undefined}
      runners={() => [
        { id: "runner-1", name: "workstation" },
        { id: "runner-2", name: "laptop" },
      ]}
    />
  ));
}

test("renders explicit, pluralized counts and an accessible bounded panel", () => {
  const html = renderPanel(
    panelState("live", ["running", "queued", "running"]),
  );

  expect(html).toContain('aria-labelledby="running-sessions-title"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('aria-atomic="true"');
  expect(html).toContain("2 Running");
  expect(html).toContain("1 Queued");
  expect(html).toContain("2 Running; 1 Queued");
  expect(html).not.toContain("2 Runnings");
  expect(html).not.toContain("1 Queueds");
  expect(html).toContain("Active task 1");
  expect(html).toContain("Running");
  expect(html).toContain("openai · gpt-5-codex");
  expect(html).toContain("workstation");
  expect(html).toContain("Open Active task 1");
  expect(html).toContain("Time: 0s");
  expect(html).not.toContain("+1 more");
});

test("renders loading, zero, and stale connection states without ambiguous totals", () => {
  const loading = renderPanel({ freshness: "loading", sessions: undefined });
  expect(loading).toContain("Loading active sessions…");
  expect(loading).toContain("Loading active sessions. Focus the session list.");
  expect(loading).not.toContain("0 Running");
  expect(loading).not.toContain("No running or queued sessions.");

  const empty = renderPanel(panelState("live", []));
  expect(empty).toContain("0 Running");
  expect(empty).toContain("0 Queued");
  expect(empty).toContain("No running or queued sessions.");

  const stale = renderPanel(panelState("stale", ["running"]));
  expect(stale).toContain("Reconnecting — last known status");
  expect(stale).toContain("1 Running");
});

test("shows a mobile loading badge before the first snapshot", () => {
  const html = renderPanel({ freshness: "loading", sessions: undefined });

  expect(html).toContain(">Loading…");
  expect(html).not.toContain("0 Running");
});

test("uses desktop panel and mobile badge responsive classes at all breakpoints", () => {
  const html = renderPanel(panelState("live", ["running"]));

  expect(html).toMatch(
    /class="[^"]*lg:hidden[^"]*"[^>]*data-running-sessions-badge="true"/u,
  );
  expect(html).toMatch(
    /class="[^"]*hidden[^"]*lg:block[^"]*xl:sticky[^"]*2xl:[^"]*"[^>]*data-running-sessions-panel="true"/u,
  );
  expect(html).toContain("sm:");
  expect(html).toContain("md:");
  expect(html).toContain("lg:");
  expect(html).toContain("xl:");
  expect(html).toContain("2xl:");
});

test("bounds the session list and exposes a control for the remaining sessions", () => {
  const html = renderPanel(
    panelState("live", [
      "running",
      "running",
      "running",
      "running",
      "queued",
      "queued",
    ]),
  );

  expect(html.match(/data-running-session-id=/gu)).toHaveLength(4);
  expect(html).toContain("+2 more");
  expect(html).toContain("Show 2 more active sessions in the session list");
  expect(
    deriveRunningSessions(panelState("live", []).sessions ?? []).runningCount,
  ).toBe(0);
});

test("status items are buttons that open sessions", () => {
  const select = vi.fn();
  const focus = vi.fn();
  const controller = new RunningSessionsController(
    panelState("live", ["running", "running", "running", "running", "queued"]),
  );
  const html = renderSolidToString(() => (
    <RunningSessionsPanel
      controller={controller}
      focusSessionList={focus}
      selectSession={select}
      runners={() => []}
    />
  ));

  expect(html).toMatch(
    /<button[^>]*data-running-session-id="active-1"[^>]*type="button"/u,
  );
  expect(html).toMatch(/<button[^>]*data-active-sessions-more="true"/u);
});
