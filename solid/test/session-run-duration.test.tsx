import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import { createLiveNow } from "../../solid/live-now.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  renderSessionPanelForTest,
  SESSION_PANEL_TEST_CONTEXT,
} from "./session-panel-test-context.ts";

test("shows the run duration beside total time in the list and detail", () => {
  // The shared clock is frozen at module import during SSR; anchor the run on
  // it so the rendered durations are exact.
  const frozenNow = createRoot(() => createLiveNow(() => false)());
  const session = {
    ...TEST_SESSION_DETAIL,
    activeDurationMs: 5_000,
    activeStartedAt: frozenNow - 8_000,
    status: "running" as const,
  };
  const selection = { detail: session, selectedId: session.id };
  const html = renderSessionPanelForTest(SESSION_PANEL_TEST_CONTEXT, {
    ...SESSION_PANEL_TEST_CONTEXT.state,
    ...selection,
    sessions: [session],
  });

  // Time sums prior runs plus the live run; Run shows only the live run.
  expect(html.match(/Time: 13s/gu)).toHaveLength(2);
  expect(html.match(/Run: 8s/gu)).toHaveLength(2);
});
