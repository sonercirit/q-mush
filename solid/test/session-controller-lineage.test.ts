import { createRoot } from "solid-js";
import { expect, test } from "vitest";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import type { SessionViewState } from "../../solid/session-client.tsx";
import { SessionController } from "../../solid/session-controller.ts";
import { initialSessionViewState } from "../../solid/session-state.ts";
import { summaryFromDetail } from "../../solid/session-summary-codec.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

test("reconnect snapshots retain child lineage regardless of event ordering", () => {
  const parent = {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: "reconnect-parent",
  };
  const child: AgentSessionSummary = {
    ...parent,
    id: "reconnect-child",
    parentExecutionGeneration: 4,
    parentSessionId: parent.id,
  };
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [parent],
  });
  const controller = createRoot(() => new SessionController(reactive));

  controller.applyDetail({
    ...TEST_SESSION_DETAIL,
    id: child.id,
    parentExecutionGeneration: child.parentExecutionGeneration,
    parentSessionId: child.parentSessionId,
  });
  controller.applyRealtime([child, parent]);
  expect(
    controller.state.sessions?.find(({ id }) => id === child.id),
  ).toMatchObject({
    parentExecutionGeneration: 4,
    parentSessionId: parent.id,
  });

  controller.applyRealtime([parent, child]);
  expect(
    controller.state.sessions?.filter(({ id }) => id === child.id),
  ).toEqual([child]);
});
