import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { RenderDebugProvider, type RenderDebugView } from "../render-debug.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import type { SessionTranscriptFilterStorage } from "../session-transcript-filters.ts";
import type { SessionCommandTransport } from "../session-transport.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

export const DOM_TEST_DISPOSALS: (() => void)[] = [];

export function mountTestView(
  renderView: () => JSX.Element,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
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

export function disposeTestViews(
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
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

function renderTestSessionDetail(
  controller: SessionController,
  state: ReturnType<typeof sessionDetailState>["state"],
): JSX.Element {
  return (
    <SessionDetail
      controller={controller}
      credentialAvailable
      runnerAvailable
      state={state()}
    />
  );
}

export function mountTestSessionDetail(
  detail: AgentSessionDetail,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
  transcriptFilterStorage: SessionTranscriptFilterStorage | null = null,
  transport?: SessionCommandTransport,
): MountedTestSession {
  const reactive = sessionDetailState(detail);
  const controller = new SessionController(
    reactive,
    undefined,
    transcriptFilterStorage,
    transport,
  );
  const container = mountTestView(
    () => renderTestSessionDetail(controller, reactive.state),
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
  const controller = new SessionController(reactive, undefined, null);
  const session = (): JSX.Element =>
    renderTestSessionDetail(controller, reactive.state);
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

export function transcriptTestMessage(
  id: string,
  content: string,
  role: AgentSessionMessage["role"],
  createdAt: number,
): AgentSessionMessage {
  return {
    content,
    createdAt,
    id,
    images: [],
    role,
    toolCallId: null,
    toolCalls: [],
    toolName: null,
  };
}

export function applyTranscriptDelta(
  controller: SessionController,
  sessionId: string,
  content: string,
  thinking = "",
): void {
  controller.applyDelta({
    content,
    sessionId,
    thinking,
    type: "session_delta",
  });
}
