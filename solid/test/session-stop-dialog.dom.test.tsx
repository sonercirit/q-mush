import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { createReactiveState } from "../reactive-state.ts";
import type { SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { initialSessionViewState } from "../session-state.ts";
import { disposeTestViews, findTestButton } from "./dom-test-helpers.ts";
import { mountSessionDetailBody } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

function runningSession(id: string): AgentSessionDetail {
  return {
    ...TEST_SESSION_DETAIL,
    id,
    status: "running",
  };
}

function mountStopSession(childCount: number) {
  const parent = runningSession("parent-stop-session");
  const children = Array.from({ length: childCount }, (_, index) => ({
    ...summaryFromDetail(TEST_SESSION_DETAIL),
    id: `child-stop-session-${String(index + 1)}`,
    parentExecutionGeneration: parent.generation,
    parentSessionId: parent.id,
  }));
  const reactive = createReactiveState<SessionViewState>({
    ...initialSessionViewState(),
    detail: parent,
    selectedId: parent.id,
    sessions: [summaryFromDetail(parent), ...children],
  });
  const mounted = mountSessionDetailBody(reactive, disposals);
  const stop = vi.spyOn(mounted.controller, "stop").mockResolvedValue();
  const click = (label: string): void => {
    const button = findTestButton(mounted.container, label);
    if (button === undefined) throw new TypeError(`Missing ${label} button`);
    button.click();
  };
  const dialog = (): Element | null =>
    mounted.container.querySelector("[data-stop-session-dialog='stop']");
  return { ...mounted, click, dialog, stop };
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("confirms stopping a session without children", () => {
  const mounted = mountStopSession(0);

  mounted.click("Stop session");
  expect(mounted.dialog()?.textContent).toMatch(/Stop this session\?/u);
  mounted.click("Stop session");
  const cancel = findTestButton(mounted.container, "Cancel");
  expect(mounted.stop).not.toHaveBeenCalled();
  cancel?.click();
  expect(mounted.dialog()).toBeNull();

  mounted.click("Stop session");
  mounted.click("Stop");
  expect(mounted.stop).toHaveBeenCalledOnce();
  expect(mounted.stop).toHaveBeenCalledWith();
});

test("maps every child-session stop choice explicitly", () => {
  const mounted = mountStopSession(2);

  mounted.click("Stop session");
  const text = mounted.dialog()?.textContent ?? "";
  expect(text).toContain("Also stop its 2 child sessions?");
  expect(text.includes("Wait for")).toBe(false);
  expect(mounted.stop).not.toHaveBeenCalled();
  mounted.click("Stop session and children");
  expect(mounted.stop).toHaveBeenLastCalledWith(true);

  mounted.click("Stop session");
  mounted.click("Stop only this session");
  expect(mounted.stop).toHaveBeenLastCalledWith(false);

  mounted.stop.mockClear();
  mounted.click("Stop session");
  expect(mounted.dialog()?.getAttribute("role")).toBe("dialog");
  mounted.click("Cancel");
  expect(mounted.stop).not.toHaveBeenCalled();
});

test("traps dialog focus and lets Escape cancel safely", async () => {
  const mounted = mountStopSession(1);
  mounted.click("Stop session");
  await Promise.resolve();

  const cancel = findTestButton(mounted.container, "Cancel");
  const cascade = findTestButton(
    mounted.container,
    "Stop session and children",
  );
  expect(document.activeElement).toBe(cancel);

  const shiftTab = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
  });
  window.dispatchEvent(shiftTab);
  expect(document.activeElement).toBe(cascade);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  expect(document.activeElement).toBe(cancel);

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(mounted.dialog()).toBeNull();
  expect(mounted.stop).not.toHaveBeenCalled();
});
