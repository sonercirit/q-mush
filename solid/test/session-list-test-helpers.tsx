import { expect } from "vitest";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionList } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { mountTestView, queryTestElement } from "./dom-test-helpers.ts";
import { trackedDisposals } from "./nested-scroll-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals = trackedDisposals();

export function mountedSessionList(
  sessions: readonly ReturnType<typeof summaryFromDetail>[],
  selectedId?: string,
) {
  const state = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    selectedId,
    sessions,
  });
  const controller = new SessionController(state);
  return {
    container: mountTestView(
      () => <SessionList controller={controller} />,
      disposals,
    ),
    controller,
    select: (sessionId: string) => {
      state.setState((current) => ({ ...current, selectedId: sessionId }));
    },
  };
}

export function query(container: ParentNode, selector: string): Element {
  return queryTestElement(container, selector);
}

export function clickButton(container: ParentNode, selector: string): void {
  const button = queryTestElement(container, selector);
  if (!(button instanceof HTMLButtonElement))
    throw new TypeError(`Missing button: ${selector}`);
  button.click();
}

export function expectDepthCount(
  container: ParentNode,
  depth: number,
  count: number,
): void {
  expect(
    container.querySelectorAll(`[data-session-depth='${String(depth)}']`),
  ).toHaveLength(count);
}

export function parentSession() {
  return {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: "parent-session",
    title: "Parent task",
  };
}

export function relatedChildren(
  parent: AgentSessionSummary,
  prefix: string,
): readonly AgentSessionSummary[] {
  return Array.from({ length: 24 }, (_, index) => ({
    ...parent,
    id: `${prefix}-${String(index + 1)}`,
    parentSessionId: parent.id,
    title: `Child ${String(index + 1)}`,
  }));
}
