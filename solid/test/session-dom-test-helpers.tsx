import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

export function mountTestView(
  renderView: () => JSX.Element,
  disposals: (() => void)[],
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(render(renderView, container));
  return container;
}

export function queryTestElement(
  container: ParentNode,
  selector: string,
): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`The test element ${selector} was not rendered`);
  }
  return element;
}

function disposeTestViews(disposals: (() => void)[]): void {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
}

export function cleanupTestViews(disposals: (() => void)[]): () => void {
  return () => {
    disposeTestViews(disposals);
  };
}

export interface MountedTestSession {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
}

export interface MountedTestTranscript extends MountedTestSession {
  readonly detail: AgentSessionDetail;
}

function mountedSession(
  detail: AgentSessionDetail,
  disposals: (() => void)[],
  includeSummary: boolean,
): MountedTestSession {
  const reactive = sessionDetailState(
    detail,
    includeSummary ? [summaryFromDetail(detail)] : undefined,
  );
  const controller = new SessionController(reactive);
  const container = mountTestView(
    () => <SessionDetail controller={controller} state={reactive.state()} />,
    disposals,
  );
  return { container, controller };
}

export function mountTestSessionDetail(
  detail: AgentSessionDetail,
  disposals: (() => void)[],
): MountedTestSession {
  return mountedSession(detail, disposals, false);
}

export function mountTestTranscript(
  messages: AgentSessionDetail["messages"],
  disposals: (() => void)[],
): MountedTestTranscript {
  const detail = runningSessionDetail(messages);
  return { ...mountedSession(detail, disposals, true), detail };
}
