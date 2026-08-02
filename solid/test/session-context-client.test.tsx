import { expect, test } from "vitest";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  renderSessionPanelForTest,
  SESSION_PANEL_TEST_CONTEXT,
} from "./session-panel-test-context.ts";

function renderContext(currentContextTokens: number): string {
  const state: SessionViewState = {
    ...SESSION_PANEL_TEST_CONTEXT.state,
    detail: {
      ...TEST_SESSION_DETAIL,
      currentContextTokens,
    },
    selectedId: TEST_SESSION_DETAIL.id,
  };
  return renderSessionPanelForTest(SESSION_PANEL_TEST_CONTEXT, state);
}

test("shows context percentage and warning colors", () => {
  const yellow = renderContext(160_000);
  const red = renderContext(180_000);
  const overLimit = renderContext(230_000);

  expect(yellow).toContain("Context: 160K / 200K (80%)");
  expect(yellow).toContain("text-amber-200");
  expect(red).toContain("Context: 180K / 200K (90%)");
  expect(red).toContain("text-rose-200");
  expect(overLimit).toContain("Context: 230K / 200K (115%)");
  expect(overLimit).toContain("text-rose-200");
});
