import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  OPENAI_PANEL,
  ProviderPanel,
  createProviderViewState,
  type ProviderCredential,
  type ProviderViewState,
} from "../provider-client.tsx";
import { ProviderController } from "../provider-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import { RenderDebugProvider, RenderDebugView } from "../render-debug.tsx";
import {
  RunnerPanel,
  createRunnerViewState,
  type RunnerViewState,
} from "../runner-client.tsx";
import { RunnerController } from "../runner-controller.ts";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { SessionDetail } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function mount(renderView: () => JSX.Element): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(render(renderView, container));
  return container;
}

function query(container: ParentNode, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(`The test element ${selector} was not rendered`);
  }
  return element;
}

function transcript(container: ParentNode): HTMLUListElement {
  const element = query(container, "[data-session-transcript='true']");
  if (!(element instanceof HTMLUListElement)) {
    throw new TypeError("The session transcript is not a list");
  }
  return element;
}

function sessionTimeText(container: ParentNode): string {
  const text = [...container.querySelectorAll("span")].find(
    ({ textContent }) =>
      textContent.startsWith("Time: ") && !textContent.includes("Cost:"),
  )?.textContent;
  if (text === undefined) {
    throw new Error("The session time was not rendered");
  }
  return text;
}

function setScrollableDimensions(
  element: HTMLElement,
  clientHeight: number,
  scrollHeight: number,
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}

function click(container: ParentNode, selector: string): void {
  const control = query(container, selector);
  if (!(control instanceof HTMLButtonElement)) {
    throw new TypeError(`The test control ${selector} is not a button`);
  }
  control.click();
}

function credential(id: string, label: string): ProviderCredential {
  return {
    accountId: null,
    id,
    isDefault: true,
    label,
    source: "api_key",
  };
}

function stubSessionRequests(catalog: AgentModelCatalog): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.resolve(
        Response.json(url.includes("/models?") ? catalog : TEST_SESSION_DETAIL),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
}

afterEach(() => {
  while (disposals.length > 0) {
    disposals.pop()?.();
  }
  document.body.replaceChildren();
});

test("provider loading, error, retry, and list updates preserve the panel", async () => {
  const reactive = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new ProviderController(OPENAI_PANEL, reactive);
  const view = (): JSX.Element => (
    <ProviderPanel configuration={OPENAI_PANEL} controller={controller} />
  );
  const container = mount(view);
  const panel = query(container, "[data-provider-panel='openai']");

  expect(container.textContent).toContain("Loading OpenAI connections…");

  reactive.setState({
    ...reactive.state(),
    error: "OpenAI is unavailable",
  });
  expect(reactive.state().error).toBe("OpenAI is unavailable");
  expect(container.textContent).toContain("OpenAI is unavailable");
  const retry = vi.spyOn(controller, "load").mockResolvedValue();
  click(container, "[role='alert'] button");
  expect(retry).toHaveBeenCalledOnce();

  const primary = credential("credential-1", "Primary");
  reactive.setState(createProviderViewState([primary]));
  await vi.waitFor(() => {
    expect(container.textContent).toContain(primary.label);
  });
  expect(container.querySelector("[data-provider-panel='openai']")).toBe(panel);

  reactive.setState(createProviderViewState([]));
  expect(container.textContent).toContain("No OpenAI accounts or keys yet");
  expect(container.querySelector("[data-provider-panel='openai']")).toBe(panel);
});

test("realtime runner changes update the list without remounting the panel", () => {
  const reactive = createReactiveState<RunnerViewState>(
    createRunnerViewState([]),
  );
  const controller = new RunnerController(reactive);
  const container = mount(() => <RunnerPanel controller={controller} />);
  const panel = query(container, "[data-runner-panel='true']");

  expect(container.textContent).toContain("No runners yet");
  controller.applyRealtime([runnerSummary(1)]);
  expect(container.textContent).toContain("workstation");

  const runnerItem = query(container, "[data-runner-id='runner-1']").closest(
    "li",
  );
  controller.applyRealtime([
    { ...runnerSummary(2), name: "renamed workstation" },
  ]);

  expect(container.textContent).toContain("renamed workstation");
  expect(container.textContent).toContain("Online");
  expect(
    query(container, "[data-runner-id='runner-1']").closest("li"),
  ).not.toBe(runnerItem);
  expect(container.querySelector("[data-runner-panel='true']")).toBe(panel);
});

function transcriptMessage(
  id: string,
  content: string,
  role: "assistant" | "user",
  createdAt: number,
): AgentSessionDetail["messages"][number] {
  const message: AgentSessionDetail["messages"][number] = {
    content,
    createdAt,
    id,
    role,
    toolName: null,
    images: [],
    toolCalls: [],
    toolCallId: null,
  };
  return message;
}

function runningSessionDetail(
  messages: AgentSessionDetail["messages"],
): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, messages, status: "running" };
}

function mountedSessionDetail(detail: AgentSessionDetail): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
} {
  const reactive = sessionDetailState(detail);
  const controller = new SessionController(reactive);
  return {
    container: mount(() => (
      <SessionDetail controller={controller} state={reactive.state()} />
    )),
    controller,
  };
}

function messageBoundary(container: ParentNode, id: string): Element {
  return query(container, `[data-render-boundary='message:${id}']`);
}

function expectStableMessages(
  container: ParentNode,
  stableUser: Element,
  stableAssistant: Element,
): void {
  expect(messageBoundary(container, "user-stable")).toBe(stableUser);
  expect(messageBoundary(container, "assistant-stable")).toBe(stableAssistant);
}

function applySessionDelta(
  controller: SessionController,
  sessionId: string,
  content: string,
): void {
  controller.applyDelta({
    content,
    sessionId,
    thinking: "",
    type: "session_delta",
  });
}

function expectScrollLock(toggle: Element, enabled: boolean): void {
  expect(toggle.textContent).toContain(
    `Scroll lock: ${enabled ? "On" : "Off"}`,
  );
  expect(toggle.getAttribute("aria-pressed")).toBe(String(enabled));
}

function expectTranscriptBoundariesToRenderOnce(
  debug: RenderDebugView,
  messageIds: readonly string[],
): void {
  for (const key of ["system-prompt", "tool-definitions", ...messageIds]) {
    expect(debug.measurement(key).count).toBe(1);
  }
}

test("a mounted session timer starts when the session begins running", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(10_000));
  disposals.push(() => {
    vi.useRealTimers();
  });
  const queued = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  const { container, controller } = mountedSessionDetail(queued);

  expect(sessionTimeText(container)).toBe("Time: 0s");
  controller.applyDetail({
    ...queued,
    activeStartedAt: Date.now(),
    status: "running",
    updatedAt: queued.updatedAt + 1,
  });
  vi.advanceTimersByTime(2_000);

  expect(sessionTimeText(container)).toBe("Time: 2s");
});

test("scrolling away from and back to the transcript end updates scroll lock", () => {
  const detail = runningSessionDetail([
    transcriptMessage("user-1", "Initial task", "user", 2),
  ]);
  const { container, controller } = mountedSessionDetail(detail);
  const element = transcript(container);
  const toggle = query(container, "[data-scroll-lock-toggle='true']");
  setScrollableDimensions(element, 100, 500);

  expectScrollLock(toggle, true);

  element.scrollTop = 180;
  element.dispatchEvent(new Event("scroll"));

  expectScrollLock(toggle, false);

  applySessionDelta(controller, detail.id, "New output");
  expect(element.scrollTop).toBe(180);

  element.scrollTop = 400;
  element.dispatchEvent(new Event("scroll"));

  expectScrollLock(toggle, true);

  setScrollableDimensions(element, 100, 650);
  applySessionDelta(controller, detail.id, " continues");
  expect(element.scrollTop).toBe(650);

  if (!(toggle instanceof HTMLButtonElement)) {
    throw new TypeError("The scroll lock control is not a button");
  }
  toggle.click();
  expectScrollLock(toggle, false);
});

test("a streamed message update only renders that transcript message", () => {
  const messages: AgentSessionDetail["messages"] = [
    transcriptMessage("user-stable", "Keep this message stable", "user", 2),
    transcriptMessage(
      "assistant-stable",
      "This one is also complete",
      "assistant",
      3,
    ),
  ];
  const detail = runningSessionDetail(messages);
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const controller = new SessionController(reactive);
  const debug = new RenderDebugView();
  const container = mount(() => (
    <RenderDebugProvider view={debug}>
      <SessionDetail controller={controller} state={reactive.state()} />
    </RenderDebugProvider>
  ));
  const stableUser = messageBoundary(container, "user-stable");
  const stableAssistant = messageBoundary(container, "assistant-stable");

  controller.applyDelta({
    content: "Streaming",
    sessionId: detail.id,
    thinking: "",
    type: "session_delta",
  });
  controller.applyDelta({
    content: " response",
    sessionId: detail.id,
    thinking: "",
    type: "session_delta",
  });

  expectStableMessages(container, stableUser, stableAssistant);
  expectTranscriptBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
  ]);
  expect(debug.measurement(`message:stream:${detail.id}:assistant`).count).toBe(
    2,
  );
  const streamedMessage = query(
    container,
    `[data-render-boundary='message:stream:${detail.id}:assistant']`,
  );

  controller.applyDetail({
    ...detail,
    messages: [
      ...messages.map((message) => ({ ...message })),
      transcriptMessage(
        "assistant-persisted",
        "Streaming response",
        "assistant",
        4,
      ),
    ],
    updatedAt: 4,
  });

  expectStableMessages(container, stableUser, stableAssistant);
  expect(
    container.querySelector(
      `[data-render-boundary='message:stream:${detail.id}:assistant']`,
    ),
  ).not.toBe(streamedMessage);
  expectTranscriptBoundariesToRenderOnce(debug, [
    "message:user-stable",
    "message:assistant-stable",
    "message:assistant-persisted",
  ]);
  expect(container.textContent).toContain("Streaming response");
});

test("session resources, drafts, realtime lists, and selected details update in place", async () => {
  const sessionState = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [],
  });
  const runnerState = createReactiveState<RunnerViewState>(
    createRunnerViewState([]),
  );
  const openAiState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const openRouterState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new SessionController(sessionState);
  const modelLabel = "Reactive model";
  const primaryCredentialLabel = "Primary";
  stubSessionRequests({
    defaultModel: "model-1",
    models: [
      {
        contextWindow: 128_000,
        id: "model-1",
        inputModalities: ["text"],
        label: modelLabel,
        outputModalities: ["text"],
        pricing: null,
        reasoningEfforts: ["high"],
      },
    ],
  });
  const container = mount(() => (
    <SessionPanel
      controller={controller}
      openAi={openAiState.state}
      openRouter={openRouterState.state}
      runners={runnerState.state}
    />
  ));
  const panel = query(container, "[data-session-panel='true']");
  const prompt = query(container, "#session-prompt");
  if (!(prompt instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session prompt is not a textarea");
  }

  expect(container.textContent).toContain("No online runners");
  expect(container.textContent).toContain("Loading credentials…");
  expect(container.textContent).toContain("No sessions yet");

  runnerState.setState(createRunnerViewState([runnerSummary(1)]));
  openAiState.setState(
    createProviderViewState([
      credential("credential-1", primaryCredentialLabel),
    ]),
  );
  openRouterState.setState(createProviderViewState([]));
  await Promise.resolve();

  expect(container.textContent).toContain("workstation");
  expect(container.textContent).toContain(primaryCredentialLabel);
  await vi.waitFor(() => {
    expect(query(container, "#session-model").textContent).toContain(
      modelLabel,
    );
  });

  controller.setDraftField("prompt", "Keep this task focused");
  expect(prompt.value).toBe("Keep this task focused");
  expect(query(container, "#session-prompt")).toBe(prompt);

  controller.applyRealtime([summaryFromDetail(TEST_SESSION_DETAIL)]);
  expect(container.textContent).toContain("Fix the app");
  click(container, `[data-session-id='${TEST_SESSION_DETAIL.id}']`);
  const sessionPromptLabel = "System prompt";
  await vi.waitFor(() => {
    expect(container.textContent).toContain(sessionPromptLabel);
  });
  expect(container.textContent).toContain("Fix the app");
  expect(container.querySelector("[data-session-panel='true']")).toBe(panel);
  expect(query(container, "#session-prompt")).toBe(prompt);
});
