import { afterEach, expect, test, vi } from "vitest";
import { SESSIONS_PATH } from "../../shared/routes.ts";
import type { AgentSessionSummary } from "../../shared/session-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import { RenderDebugProvider, RenderDebugView } from "../render-debug.tsx";
import { RunningSessionsController } from "../running-sessions-controller.ts";
import { RunningSessionsPanel } from "../running-sessions-panel.tsx";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import { mountTestView } from "./dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function mount(
  renderView: Parameters<typeof mountTestView>[0],
): HTMLDivElement {
  return mountTestView(renderView, disposals);
}

function runningSession(id: string, title: string): AgentSessionSummary {
  return {
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    activeStartedAt: Date.now(),
    id,
    status: "running",
    title,
  };
}

afterEach(() => {
  while (disposals.length > 0) {
    disposals.pop()?.();
  }
  document.body.replaceChildren();
});

test("realtime transitions update counts with keyed stable session identity", () => {
  const first = runningSession("session-1", "First task");
  const second = runningSession("session-2", "Second task");
  const controller = new RunningSessionsController({
    freshness: "live",
    sessions: [first, second],
  });
  const select = vi.fn();
  const container = mount(() => (
    <RunningSessionsPanel
      controller={controller}
      focusSessionList={() => undefined}
      selectSession={select}
      runners={() => []}
    />
  ));
  const firstButton = container.querySelector(
    "[data-running-session-id='session-1']",
  );

  expect(container.textContent).toContain("2 Running");
  controller.applySession({ ...second, status: "idle", updatedAt: 3 });

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
  const controller = new RunningSessionsController({
    freshness: "live",
    sessions: [session],
  });
  const debug = new RenderDebugView();
  const container = mount(() => (
    <RenderDebugProvider view={debug}>
      <RunningSessionsPanel
        controller={controller}
        focusSessionList={() => undefined}
        selectSession={() => undefined}
        runners={() => []}
      />
    </RenderDebugProvider>
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
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
    },
    { preconnect: originalFetch.preconnect },
  );
  disposals.push(() => {
    globalThis.fetch = originalFetch;
  });
  const runningController = new RunningSessionsController({
    freshness: "live",
    sessions: [session],
  });
  const container = mount(() => (
    <RunningSessionsPanel
      controller={runningController}
      focusSessionList={() => {
        sessionController.focusList();
      }}
      selectSession={(sessionId) => {
        void sessionController.selectAndFocus(sessionId);
      }}
      runners={() => []}
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
  const controller = new RunningSessionsController({
    freshness: "live",
    sessions: Array.from({ length: 5 }, (_, index) =>
      runningSession(
        `session-${String(index + 1)}`,
        `Task ${String(index + 1)}`,
      ),
    ),
  });
  const focus = vi.fn();
  const container = mount(() => (
    <RunningSessionsPanel
      controller={controller}
      focusSessionList={focus}
      selectSession={() => undefined}
      runners={() => []}
    />
  ));
  const more = container.querySelector("[data-active-sessions-more='true']");

  if (!(more instanceof HTMLButtonElement)) {
    throw new TypeError("The active-session overflow control is not a button");
  }
  more.click();
  expect(focus).toHaveBeenCalledOnce();
});
