import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type {
  AgentSessionDetail,
  AgentSessionMessage,
} from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import type { SessionTranscriptFilterStorage } from "../session-transcript-filters.ts";
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

export function transcriptMessageElement(
  container: ParentNode,
  content: string,
  label: "Agent" | "Thinking" | "You" = "You",
): Element {
  const transcript = queryTestElement(container, "[data-session-transcript]");
  const message = [...transcript.children].find(
    (item) =>
      item.firstElementChild?.textContent.trim() === label &&
      item.textContent.includes(content),
  );
  if (message === undefined) {
    throw new Error(`The transcript message ${content} was not rendered`);
  }
  return message;
}

export function disposeTestViews(
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
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

function mountTestSession(
  detail: AgentSessionDetail,
  disposals: (() => void)[],
  transcriptFilterStorage: SessionTranscriptFilterStorage | null,
  includeSummary: boolean,
): MountedTestSession {
  const reactive = sessionDetailState(
    detail,
    includeSummary ? [summaryFromDetail(detail)] : undefined,
  );
  const controller = new SessionController(
    reactive,
    undefined,
    transcriptFilterStorage,
  );
  const container = mountTestView(
    () => renderTestSessionDetail(controller, reactive.state),
    disposals,
  );
  return { container, controller };
}

export function mountTestSessionDetail(
  detail: AgentSessionDetail,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
  transcriptFilterStorage: SessionTranscriptFilterStorage | null = null,
): MountedTestSession {
  return mountTestSession(detail, disposals, transcriptFilterStorage, false);
}

export function mountTestTranscript(
  messages: AgentSessionDetail["messages"],
  disposals: (() => void)[],
): MountedTestTranscript {
  const detail = runningSessionDetail(messages);
  return { ...mountTestSession(detail, disposals, null, true), detail };
}

export function createResponseFetch(
  response: unknown,
): typeof globalThis.fetch {
  const originalFetch = globalThis.fetch;
  return Object.assign(
    (): Promise<Response> => Promise.resolve(Response.json(response)),
    { preconnect: originalFetch.preconnect },
  );
}

export function restoreFetchAfterTest(
  originalFetch: typeof globalThis.fetch,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
  disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
}

export function installResponseFetch(
  response: unknown,
  disposals: (() => void)[] = DOM_TEST_DISPOSALS,
): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createResponseFetch(response);
  restoreFetchAfterTest(originalFetch, disposals);
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
