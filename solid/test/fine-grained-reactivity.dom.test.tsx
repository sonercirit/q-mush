import type { JSX } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentModelCatalog } from "../../shared/agent-configuration.ts";
import type {
  AgentSessionDetail,
  AgentSessionSummary,
} from "../../shared/session-model.ts";
import { OPENAI_PANEL } from "../provider-client.tsx";
import { ProviderController } from "../provider-controller.ts";
import {
  createProviderViewState,
  type ProviderCredential,
  type ProviderViewState,
} from "../provider-credential-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import {
  RunnerPanel,
  createRunnerViewState,
  type RunnerViewState,
} from "../runner-client.tsx";
import { RunnerController } from "../runner-controller.ts";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { SessionController } from "../session-controller.ts";
import { SessionList } from "../session-detail-client.tsx";
import { initialSessionViewState } from "../session-state.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import {
  clickTestButton,
  disposeTestViews,
  expectTestText,
  mountTestView,
  queryTestElement,
  queryTestTranscript,
} from "./dom-test-helpers.ts";
import { defineElementSize } from "./element-size-test-helpers.ts";
import { openAiProviderPanel } from "./provider-panel-fixtures.tsx";
import { runnerSummary } from "./runner-fixtures.ts";
import { applySessionDelta } from "./session-controller-stream-test-helper.ts";
import {
  mountSessionDetailBody,
  mountTestSessionDetail,
  restoreFetchAfterTest,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import {
  runningSessionDetail,
  transcriptMessage,
} from "./transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function mount(renderView: () => JSX.Element): HTMLDivElement {
  return mountTestView(renderView, disposals);
}

interface MountedSessionList {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
  readonly select: (sessionId: string) => void;
}

function mountedSessionList(
  sessions: readonly ReturnType<typeof summaryFromDetail>[],
  selectedId?: string,
): MountedSessionList {
  const state = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    selectedId,
    sessions,
  });
  const controller = new SessionController(state);
  return {
    container: mount(() => <SessionList controller={controller} />),
    controller,
    select: (sessionId: string) => {
      state.setState((current) => ({ ...current, selectedId: sessionId }));
    },
  };
}

function query(container: ParentNode, selector: string): Element {
  return queryTestElement(container, selector);
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
    (input: RequestInfo | URL) => {
      let url: string;
      if (typeof input === "string") url = input;
      else if (input instanceof URL) url = input.href;
      else url = input.url;
      return Promise.resolve(
        Response.json(url.includes("/models?") ? catalog : TEST_SESSION_DETAIL),
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  restoreFetchAfterTest(originalFetch, disposals);
}

afterEach(() => {
  disposeTestViews(disposals);
});

function waitForSessionModel(
  container: ParentNode,
  label: string,
): Promise<void> {
  return vi.waitFor(() => {
    expect(query(container, "#session-model").textContent).toContain(label);
  });
}

function createNewSessionState(): ReturnType<
  typeof createReactiveState<SessionViewState>
> {
  return createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [],
  });
}

test("provider loading, error, retry, and list updates preserve the panel", async () => {
  const reactive = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new ProviderController(OPENAI_PANEL, reactive);
  const view = (): JSX.Element => openAiProviderPanel(controller);
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
  clickTestButton(container, "[role='alert'] button");
  expect(retry).toHaveBeenCalledOnce();

  const primary = credential("credential-1", "Primary");
  reactive.setState(createProviderViewState([primary]));
  await expectTestText(container, primary.label);
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

function mountSessionDetail(detail: AgentSessionDetail): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
} {
  return mountTestSessionDetail(detail, disposals);
}

function applyDeltaContent(
  controller: SessionController,
  sessionId: string,
  content: string,
): void {
  applySessionDelta(controller, {
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

test("scrolling away from and back to the transcript end updates scroll lock", () => {
  const detail = runningSessionDetail([
    transcriptMessage("user-1", "Initial task", "user", 2),
  ]);
  const { container, controller } = mountSessionDetail(detail);
  const element = queryTestTranscript(container);
  const toggle = query(container, "[data-scroll-lock-toggle='true']");
  defineElementSize(element, 100, 500);

  expectScrollLock(toggle, true);

  element.scrollTop = 180;
  element.dispatchEvent(new Event("scroll"));

  expectScrollLock(toggle, false);

  applyDeltaContent(controller, detail.id, "New output");
  expect(element.scrollTop).toBe(180);

  element.scrollTop = 400;
  element.dispatchEvent(new Event("scroll"));

  expectScrollLock(toggle, true);

  if (!(toggle instanceof HTMLButtonElement)) {
    throw new TypeError("The scroll lock control is not a button");
  }
  toggle.click();
  expectScrollLock(toggle, false);
});

function parentSession() {
  return {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: "parent-session",
    title: "Parent task",
  };
}

function relatedSession(
  parent: AgentSessionSummary,
  id: string,
  title: string,
  parentSessionId: string | null = parent.id,
): AgentSessionSummary {
  return { ...parent, id, parentSessionId, title };
}

function expectSessionDepth(
  container: ParentNode,
  sessionId: string,
  depth: number,
): void {
  const item = query(container, `[data-session-id='${sessionId}']`).closest(
    "li",
  );
  expect(item?.getAttribute("data-session-depth")).toBe(String(depth));
}

function childGroupSession(
  container: ParentNode,
  parentId: string,
  childId: string,
): Element | null {
  return query(
    container,
    `[data-child-session-group='${parentId}']`,
  ).querySelector(`[data-session-id='${childId}']`);
}

test("renders status badges in session list rows", () => {
  for (const [status, label] of [
    ["idle", "Ready"],
    ["completed", "Completed"],
  ] as const) {
    const session = { ...parentSession(), id: `status-${status}`, status };
    const { container } = mountedSessionList([session]);
    expect(
      query(container, `[data-session-id='${session.id}']`).textContent,
    ).toContain(label);
  }
});

test("nests spawned sessions under a collapsed parent", () => {
  const parent = parentSession();
  const child = relatedSession(parent, "child-session", "Delegated task");
  const detached = relatedSession(
    parent,
    "detached-session",
    "Detached task",
    "missing-parent",
  );
  const { container } = mountedSessionList([child, detached, parent]);
  const parentToggle = query(
    container,
    "button[aria-label='Expand child sessions for Parent task']",
  );
  expect(parentToggle.getAttribute("aria-expanded")).toBe("false");
  expect(parentToggle.textContent).toContain("Expand (1)");
  expect(
    container.querySelector("[data-session-id='child-session']"),
  ).toBeNull();
  expect(
    container.querySelector("[data-session-id='detached-session']"),
  ).not.toBeNull();

  if (!(parentToggle instanceof HTMLButtonElement)) {
    throw new TypeError("The child session toggle is not a button");
  }
  parentToggle.click();

  expect(
    query(
      container,
      "button[aria-label='Collapse child sessions for Parent task']",
    ).textContent,
  ).toContain("Collapse (1)");
  expect(childGroupSession(container, parent.id, child.id)).not.toBeNull();
  expect(
    container.querySelectorAll("[data-session-id='child-session']"),
  ).toHaveLength(1);
  expectSessionDepth(container, child.id, 1);
});

test("bounds expanded children while revealing the selected child", () => {
  const parent = parentSession();
  const children = Array.from({ length: 24 }, (_, index) => ({
    ...parent,
    id: `child-${String(index + 1)}`,
    parentSessionId: parent.id,
    title: `Child ${String(index + 1)}`,
  }));
  const selected = children.at(-1);
  if (selected === undefined) throw new TypeError("Missing selected child");
  const { container, select } = mountedSessionList([parent, ...children]);

  expect(container.querySelectorAll("[data-session-id]")).toHaveLength(1);
  select(selected.id);
  expect(container.querySelectorAll("[data-session-id]")).toHaveLength(11);
  expect(
    query(
      container,
      "button[aria-label='Collapse child sessions for Parent task']",
    ).textContent,
  ).toContain("Collapse (24)");
  expect(
    query(container, `[data-session-id='${selected.id}']`).getAttribute(
      "aria-current",
    ),
  ).toBe("true");
  expect(
    container.querySelector("[data-load-more-sessions='true']"),
  ).toBeNull();
  expect(
    container.querySelector("[data-load-more-children='parent-session']"),
  ).not.toBeNull();
});

test("reparents realtime rows without leaving a duplicate root", () => {
  const parent = parentSession();
  const child = relatedSession(
    parent,
    "realtime-child",
    "Realtime child",
    null,
  );
  const { container, controller, select } = mountedSessionList([child, parent]);
  select(child.id);
  expectSessionDepth(container, child.id, 0);

  controller.applyRealtime([
    parent,
    {
      ...child,
      parentExecutionGeneration: 0,
      parentSessionId: parent.id,
    },
  ]);

  expect(
    container.querySelectorAll("[data-session-id='realtime-child']"),
  ).toHaveLength(1);
  expect(
    childGroupSession(container, parent.id, child.id),
    "the grouped child",
  ).toBeTruthy();
  expectSessionDepth(container, child.id, 1);
});

test("loads more sessions on scroll and resets for a new root", () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: `session-${String(index + 1)}`,
    title: `Task ${String(index + 1)}`,
    updatedAt: 100 - index,
  }));
  const { container, controller } = mountedSessionList(sessions);
  const sessionButtons = (): NodeListOf<HTMLButtonElement> =>
    container.querySelectorAll("button[data-session-id]");
  const list = query(container, ".session-list-items");
  if (!(list instanceof HTMLUListElement)) {
    throw new TypeError("The session list is not a list");
  }
  defineElementSize(list, 100, 500);

  expect(sessionButtons()).toHaveLength(10);
  expect(container.querySelector(".session-list-pagination")).toBeNull();
  expect(container.querySelector("[data-session-id='session-11']")).toBeNull();

  for (const scrollTop of [300, 350]) {
    list.scrollTop = scrollTop;
    list.dispatchEvent(new Event("scroll"));
    expect(sessionButtons()).toHaveLength(scrollTop === 300 ? 10 : 12);
  }
  expect(
    container.querySelector("[data-load-more-sessions='true']"),
  ).toBeNull();

  const firstSession = sessions[0];
  if (firstSession === undefined) {
    throw new TypeError("Missing first session");
  }
  const added = {
    ...firstSession,
    id: "session-13",
    title: "Task 13",
  };
  controller.applyRealtime([...sessions, added]);

  expect(sessionButtons()).toHaveLength(10);
  clickTestButton(container, "[data-load-more-sessions='true']");
  expect(sessionButtons()).toHaveLength(13);
  expect(
    container.querySelector("[data-load-more-sessions='true']"),
  ).toBeNull();
});

test("selected transcript deltas do not rebuild the multi-session hierarchy", () => {
  const selected = {
    ...TEST_SESSION_DETAIL,
    status: "running" as const,
  };
  let hierarchyReads = 0;
  const sessions = Array.from({ length: 50 }, (_, index) => {
    const summary = {
      ...summaryFromDetail(selected),
      id: index === 0 ? selected.id : `background-${String(index)}`,
    };
    const parentSessionId = summary.parentSessionId;
    Object.defineProperty(summary, "parentSessionId", {
      get: () => {
        hierarchyReads += 1;
        return parentSessionId;
      },
    });
    return summary;
  });
  const controller = new SessionController(
    createReactiveState<SessionViewState>({
      ...initialSessionViewState(),
      detail: selected,
      selectedId: selected.id,
      sessions,
    }),
    undefined,
    null,
  );
  const container = mount(() => <SessionList controller={controller} />);
  const visibleRows = [...container.querySelectorAll("[data-session-id]")];
  const readsAfterMount = hierarchyReads;

  applyDeltaContent(controller, selected.id, "Live output");

  expect(hierarchyReads).toBe(readsAfterMount);
  expect([...container.querySelectorAll("[data-session-id]")]).toEqual(
    visibleRows,
  );
  expect(controller.state.detail?.messages.at(-1)?.content).toBe("Live output");
});

test("keeps a running tool visible while a stop request is pending", () => {
  const running = {
    ...TEST_SESSION_DETAIL,
    messages: [
      transcriptMessage(
        `stream:${TEST_SESSION_DETAIL.id}:assistant`,
        "",
        "assistant",
        TEST_SESSION_DETAIL.updatedAt,
      ),
    ],
    status: "running" as const,
    updatedAt: 3,
  };
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail: running,
    selectedId: running.id,
    sessions: [summaryFromDetail(running)],
    stopping: true,
    toolStreams: [
      {
        arguments: '{"command":"sleep 1"}',
        callId: "call-running",
        index: 0,
        name: "bash",
        sequence: 1,
        sessionId: running.id,
        state: "running",
        stderr: "",
        stdout: "still working",
        streamId: "stream-running",
      },
    ],
  });
  const { container } = mountSessionDetailBody(reactive, disposals);

  expect(container.textContent).toContain("Running");
  expect(
    container.querySelector("[data-tool-stream-state='running']"),
  ).not.toBeNull();
});

test("session resources, drafts, realtime lists, and selected details update in place", async () => {
  const sessionState = createNewSessionState();
  const runnerState = createReactiveState<RunnerViewState>(
    createRunnerViewState([]),
  );
  const openAiState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const openRouterState = createReactiveState<ProviderViewState>(
    createProviderViewState(undefined),
  );
  const controller = new SessionController(sessionState, undefined, undefined);
  const modelLabel = "Reactive model";
  const primaryCredentialLabel = "Primary";
  const model = {
    adaptiveThinking: null,
    contextWindow: 128_000,
    id: "model-1",
    inputModalities: ["text"] as const,
    label: modelLabel,
    maxOutputTokens: null,
    outputModalities: ["text"] as const,
    pricing: null,
    reasoningEfforts: ["high"] as const,
  };
  stubSessionRequests({ defaultModel: model.id, models: [model] });
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
  await waitForSessionModel(container, modelLabel);

  controller.setDraftField("prompt", "Keep this task focused");
  expect(prompt.value).toBe("Keep this task focused");
  expect(query(container, "#session-prompt")).toBe(prompt);

  controller.applyRealtime([summaryFromDetail(TEST_SESSION_DETAIL)]);
  expect(container.textContent).toContain("Fix the app");
  controller.setTranscriptFilter("systemPrompt", true);
  clickTestButton(container, `[data-session-id='${TEST_SESSION_DETAIL.id}']`);
  const sessionPromptLabel = "System prompt";
  await vi.waitFor(() => {
    expect(container.textContent).toContain(sessionPromptLabel);
  });
  expect(container.textContent).toContain("Fix the app");
  expect(container.querySelector("[data-session-panel='true']")).toBe(panel);
  expect(query(container, "#session-prompt")).toBe(prompt);
});
