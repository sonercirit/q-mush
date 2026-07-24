import { afterEach, expect, test, vi } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { RenderDebugView } from "../render-debug.tsx";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import { installFetch, requestUrl } from "./controller-test-helpers.ts";
import {
  createRunningSessionsController,
  TestRunningSessionsPanel,
} from "./running-sessions-panel-fixtures.tsx";
import {
  cleanupDomTestScope,
  DOM_TEST_SCOPE,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const dom = DOM_TEST_SCOPE;
const mount = dom.mount.bind(dom);

function runningSession(id: string, title: string): AgentSessionSummary {
  return {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    activeStartedAt: Date.now(),
    id,
    status: "running",
    title,
  };
}

function renderPanel(
  controller: ReturnType<typeof createRunningSessionsController>,
  options: {
    readonly focusSessionList?: () => void;
    readonly selectSession?: (sessionId: string) => void;
  } = {},
): HTMLDivElement {
  return mount(() => (
    <TestRunningSessionsPanel controller={controller} {...options} />
  ));
}

afterEach(cleanupDomTestScope);

test("realtime transitions update counts with keyed stable session identity", () => {
  const first = runningSession("session-1", "First task");
  const second = runningSession("session-2", "Second task");
  const controller = createRunningSessionsController([first, second]);
  const select = vi.fn();
  const container = renderPanel(controller, { selectSession: select });
  const firstButton = container.querySelector(
    "[data-running-session-id='session-1']",
  );

  expect(container.textContent).toContain("2 Running");
  controller.applySnapshot([
    { ...second, status: "idle", updatedAt: 3 },
    first,
  ]);
  expect(container.textContent).toContain("1 Running");
  expect(container.querySelector("[data-running-session-id='session-1']")).toBe(
    firstButton,
  );
  expect(
    container.querySelector("[data-running-session-id='session-2']"),
  ).toBeNull();

  if (!(firstButton instanceof HTMLButtonElement)) {
    throw new TypeError("The running-session control is not a button");
  }
  firstButton.focus();
  firstButton.click();
  expect(document.activeElement).toBe(firstButton);
  expect(select).toHaveBeenCalledWith("session-1");
});

test("model deltas do not rerender or recount the running panel", () => {
  const session = runningSession("session-1", "Stable task");
  const controller = createRunningSessionsController([session]);
  const debug = new RenderDebugView();
  const container = mount(() => (
    <TestRunningSessionsPanel controller={controller} debug={debug} />
  ));
  const panel = container.querySelector("[data-running-sessions-panel='true']");
  const liveRegion = container.querySelector("[aria-live='polite']");
  const item = container.querySelector("[data-running-session-id='session-1']");

  controller.applyDelta();
  controller.applyDelta();

  expect(container.querySelector("[data-running-sessions-panel='true']")).toBe(
    panel,
  );
  expect(container.querySelector("[aria-live='polite']")).toBe(liveRegion);
  expect(liveRegion?.textContent).toBe("1 Running; 0 Queued");
  expect(container.querySelector("[data-running-session-id='session-1']")).toBe(
    item,
  );
  expect(debug.measurement("running-sessions-panel").count).toBe(1);
  expect(debug.measurement("running-session:session-1").count).toBe(1);
});

test("uses one shared timer for every running-session time display", () => {
  dom.useFakeTime(10_000);
  const setInterval = vi.spyOn(window, "setInterval");
  const controller = createRunningSessionsController([
    runningSession("session-1", "First task"),
    runningSession("session-2", "Second task"),
  ]);
  const container = mount(() => (
    <TestRunningSessionsPanel controller={controller} />
  ));

  expect(setInterval).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(2_000);
  expect(container.textContent.match(/Time: 2s/gu)).toHaveLength(2);

  controller.applySnapshot([]);
  expect(vi.getTimerCount()).toBe(0);
  setInterval.mockRestore();
});

test("selecting a status item opens the session and focuses its full-list entry", async () => {
  const session = runningSession("session-1", "Selected task");
  const sessionState = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    sessions: [session],
    sessionsSource: "realtime" as const,
  });
  const sessionController = new SessionController(sessionState);
  const list = document.createElement("aside");
  list.tabIndex = -1;
  const scrollIntoView = vi.fn();
  list.scrollIntoView = scrollIntoView;
  document.body.append(list);
  sessionController.setListElement(list);
  dom.restore(
    installFetch((input) => {
      const url = requestUrl(input);
      if (url !== `${SESSIONS_PATH}/${session.id}`) {
        throw new Error(`Unexpected request: ${url}`);
      }
      return Promise.resolve(
        Response.json({
          ...TEST_SESSION_DETAIL,
          activeStartedAt: session.activeStartedAt,
          id: session.id,
          status: "running",
          title: session.title,
        }),
      );
    }),
  );
  const container = mount(() => (
    <TestRunningSessionsPanel
      controller={createRunningSessionsController([session])}
      selectSession={(sessionId) => {
        void sessionController.selectAndFocus(sessionId);
      }}
    />
  ));
  const control = container.querySelector(
    "[data-running-session-id='session-1']",
  );

  if (!(control instanceof HTMLButtonElement)) {
    throw new TypeError("The running-session control is not a button");
  }
  control.click();
  await vi.waitFor(() => {
    expect(sessionController.state.selectedId).toBe("session-1");
    expect(document.activeElement).toBe(list);
  });
  expect(scrollIntoView).toHaveBeenCalled();
});

test("the overflow control focuses the full session list", () => {
  const sessions = Array.from({ length: 5 }, (_, index) =>
    runningSession(`session-${String(index + 1)}`, `Task ${String(index + 1)}`),
  );
  const focus = vi.fn();
  const container = renderPanel(createRunningSessionsController(sessions), {
    focusSessionList: focus,
  });
  const more = container.querySelector("[data-active-sessions-more='true']");

  if (!(more instanceof HTMLButtonElement)) {
    throw new TypeError("The active-session overflow control is not a button");
  }
  more.click();
  expect(focus).toHaveBeenCalledOnce();
});
