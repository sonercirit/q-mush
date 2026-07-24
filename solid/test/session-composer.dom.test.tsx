import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  disposeTestViews,
  mountTestSessionDetail,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

// cpd-ignore-start -- Explicit key gestures intentionally repeat complete keyboard interactions.
function runningSessionDetail(): AgentSessionDetail {
  return { ...TEST_SESSION_DETAIL, status: "running" };
}

function mountedSessionDetail(detail: AgentSessionDetail) {
  return mountTestSessionDetail(detail, disposals);
}

function textarea(container: ParentNode): HTMLTextAreaElement {
  const element = container.querySelector("textarea[name='prompt']");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new TypeError("The session composer is not a textarea");
  }
  return element;
}

function keyDown(
  element: HTMLTextAreaElement,
  options: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...options,
  });
  element.dispatchEvent(event);
  return event;
}

afterEach(() => {
  disposeTestViews(disposals);
});

test("running composer shortcuts queue follow-up and steer once", () => {
  const detail = runningSessionDetail();
  const { container, controller } = mountedSessionDetail(detail);
  const followUp = vi.spyOn(controller, "followUp").mockResolvedValue();
  const steer = vi.spyOn(controller, "steer").mockResolvedValue();
  controller.setFollowUp("Queued instruction");
  const composer = textarea(container);

  const composing = keyDown(composer, {
    ctrlKey: true,
    isComposing: true,
    key: "Enter",
  });
  expect(composing.defaultPrevented).toBe(false);
  expect(followUp).not.toHaveBeenCalled();

  const plain = keyDown(composer, { key: "Enter" });
  expect(plain.defaultPrevented).toBe(false);

  const followEvent = keyDown(composer, { ctrlKey: true, key: "Enter" });
  expect(followEvent.defaultPrevented).toBe(true);
  expect(followUp).toHaveBeenCalledOnce();
  expect(steer).not.toHaveBeenCalled();

  const steerEvent = keyDown(composer, { key: "Enter", shiftKey: true });
  expect(steerEvent.defaultPrevented).toBe(true);
  expect(steer).toHaveBeenCalledOnce();
});

test("shows a macOS primary-shortcut hint after mounting", () => {
  const platform = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue("MacIntel");
  disposals.push(() => {
    platform.mockRestore();
  });
  const { container } = mountedSessionDetail(runningSessionDetail());

  expect(container.textContent).toContain("⌘+Enter");
  expect(container.textContent).not.toContain("Ctrl+Enter");
  const followUp = [...container.querySelectorAll("button")].find(
    ({ textContent }) => textContent.includes("Follow up"),
  );
  expect(followUp?.getAttribute("aria-keyshortcuts")).toBe("Meta+Enter");
});

test("queued composer shortcuts follow up but do not steer", () => {
  const queued = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  const { container, controller } = mountedSessionDetail(queued);
  const followUp = vi.spyOn(controller, "followUp").mockResolvedValue();
  const steer = vi.spyOn(controller, "steer").mockResolvedValue();
  const composer = textarea(container);

  const followEvent = keyDown(composer, { ctrlKey: true, key: "Enter" });
  const steerEvent = keyDown(composer, { key: "Enter", shiftKey: true });

  expect(followEvent.defaultPrevented).toBe(true);
  expect(followUp).toHaveBeenCalledOnce();
  expect(steerEvent.defaultPrevented).toBe(false);
  expect(steer).not.toHaveBeenCalled();
  const steerButton = [...container.querySelectorAll("button")].find(
    ({ textContent }) => textContent.includes("Steer"),
  );
  expect(steerButton?.disabled).toBe(true);
});

test("Shift+Enter continues an idle session and ignores composition", () => {
  const { container, controller } = mountedSessionDetail(TEST_SESSION_DETAIL);
  const continueSession = vi
    .spyOn(controller, "continueSession")
    .mockResolvedValue();
  const composer = textarea(container);

  keyDown(composer, { isComposing: true, key: "Enter", shiftKey: true });
  expect(continueSession).not.toHaveBeenCalled();

  const event = keyDown(composer, { key: "Enter", shiftKey: true });
  expect(event.defaultPrevented).toBe(true);
  expect(continueSession).toHaveBeenCalledOnce();
});
// cpd-ignore-end
