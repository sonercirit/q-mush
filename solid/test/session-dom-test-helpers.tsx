import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { RenderDebugProvider, type RenderDebugView } from "../render-debug.tsx";
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

export function messageBoundary(container: ParentNode, id: string): Element {
  return queryTestElement(container, `[data-render-boundary='message:${id}']`);
}

export function disposeTestViews(disposals: (() => void)[]): void {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
}

export interface MountedTestSession {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
}

export interface MountedTestTranscript extends MountedTestSession {
  readonly detail: AgentSessionDetail;
}

export function mountTestSessionDetail(
  detail: AgentSessionDetail,
  disposals: (() => void)[],
): MountedTestSession {
  const reactive = sessionDetailState(detail);
  const controller = new SessionController(reactive);
  const container = mountTestView(
    () => <SessionDetail controller={controller} state={reactive.state()} />,
    disposals,
  );
  return { container, controller };
}

export function mountTestTranscript(
  messages: AgentSessionDetail["messages"],
  disposals: (() => void)[],
  debug?: RenderDebugView,
): MountedTestTranscript {
  const detail = runningSessionDetail(messages);
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const controller = new SessionController(reactive);
  const session = () => (
    <SessionDetail controller={controller} state={reactive.state()} />
  );
  const container = mountTestView(
    () =>
      debug === undefined ? (
        session()
      ) : (
        <RenderDebugProvider view={debug}>{session()}</RenderDebugProvider>
      ),
    disposals,
  );
  return { container, controller, detail };
}
