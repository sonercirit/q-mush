import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { RenderDebugProvider, type RenderDebugView } from "../render-debug.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

function mountIntoDocument(
  renderView: () => JSX.Element,
  register: (dispose: () => void) => void,
): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  register(render(renderView, container));
  return container;
}

function disposeAll(disposals: (() => void)[]): void {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
}

function clearDocument(): void {
  document.body.replaceChildren();
}

class DomTestScope {
  readonly #disposals: (() => void)[] = [];

  dispose(): void {
    disposeAll(this.#disposals);
    clearDocument();
  }

  mount(renderView: () => JSX.Element): HTMLDivElement {
    return mountIntoDocument(renderView, (dispose) => {
      this.#disposals.push(dispose);
    });
  }

  restore(restore: () => void): void {
    this.#disposals.push(restore);
  }

  useFakeTime(timestamp: number): void {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    this.#disposals.push(() => {
      vi.useRealTimers();
    });
  }

  withDisposals<Value>(setup: (disposals: (() => void)[]) => Value): Value {
    return setup(this.#disposals);
  }
}

export const DOM_TEST_SCOPE = new DomTestScope();

export function cleanupDomTestScope(): void {
  DOM_TEST_SCOPE.dispose();
}

function mountTestView(
  renderView: () => JSX.Element,
  disposals: (() => void)[],
): HTMLDivElement {
  return mountIntoDocument(renderView, (dispose) => {
    disposals.push(dispose);
  });
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
  disposeAll(disposals);
  clearDocument();
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
