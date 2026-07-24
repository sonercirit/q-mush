import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import {
  disposeTestViews,
  mountTestSessionDetail,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals: (() => void)[] = [];

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

function actionButton(container: ParentNode, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    ({ textContent }) => textContent.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new TypeError(`The ${label} action was not rendered`);
  }
  return button;
}

afterEach(() => {
  disposeTestViews(disposals);
  vi.restoreAllMocks();
});

// cpd-ignore-start -- Shortcut cases intentionally repeat full browser key and button assertions.
test("running composer uses primary Enter for follow-up and shifted primary Enter for steer", () => {
  const detail = { ...TEST_SESSION_DETAIL, status: "running" as const };
  const { container, controller } = mountedSessionDetail(detail);
  const followUp = vi.spyOn(controller, "followUp").mockResolvedValue();
  const steer = vi.spyOn(controller, "steer").mockResolvedValue();
  const composer = textarea(container);

  const composing = keyDown(composer, {
    ctrlKey: true,
    isComposing: true,
    key: "Enter",
  });
  const plain = keyDown(composer, { key: "Enter" });
  const newline = keyDown(composer, { key: "Enter", shiftKey: true });
  const followEvent = keyDown(composer, { ctrlKey: true, key: "Enter" });
  const steerEvent = keyDown(composer, {
    ctrlKey: true,
    key: "Enter",
    shiftKey: true,
  });

  expect(composing.defaultPrevented).toBe(false);
  expect(plain.defaultPrevented).toBe(false);
  expect(newline.defaultPrevented).toBe(false);
  expect(followEvent.defaultPrevented).toBe(true);
  expect(steerEvent.defaultPrevented).toBe(true);
  expect(followUp).toHaveBeenCalledOnce();
  expect(steer).toHaveBeenCalledOnce();
  expect(
    actionButton(container, "Follow up").getAttribute("aria-keyshortcuts"),
  ).toBe("Control+Enter");
  expect(
    actionButton(container, "Steer").getAttribute("aria-keyshortcuts"),
  ).toBe("Control+Shift+Enter");
});

test("macOS exposes Command shortcuts for both active actions", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const { container } = mountedSessionDetail({
    ...TEST_SESSION_DETAIL,
    status: "running",
  });

  expect(actionButton(container, "Follow up").textContent).toContain("⌘+Enter");
  expect(
    actionButton(container, "Follow up").getAttribute("aria-keyshortcuts"),
  ).toBe("Meta+Enter");
  expect(actionButton(container, "Steer").textContent).toContain(
    "⌘+Shift+Enter",
  );
  expect(
    actionButton(container, "Steer").getAttribute("aria-keyshortcuts"),
  ).toBe("Meta+Shift+Enter");
});

test("queued composer accepts follow-ups, preserves newlines, and disables steer", () => {
  const detail = { ...TEST_SESSION_DETAIL, status: "queued" as const };
  const { container, controller } = mountedSessionDetail(detail);
  const followUp = vi.spyOn(controller, "followUp").mockResolvedValue();
  const steer = vi.spyOn(controller, "steer").mockResolvedValue();
  const composer = textarea(container);

  const newline = keyDown(composer, { key: "Enter", shiftKey: true });
  const followEvent = keyDown(composer, { metaKey: true, key: "Enter" });
  const steerEvent = keyDown(composer, {
    key: "Enter",
    metaKey: true,
    shiftKey: true,
  });

  expect(composer.readOnly).toBe(false);
  expect(newline.defaultPrevented).toBe(false);
  expect(followEvent.defaultPrevented).toBe(true);
  expect(steerEvent.defaultPrevented).toBe(true);
  expect(followUp).toHaveBeenCalledOnce();
  expect(steer).not.toHaveBeenCalled();
  expect(actionButton(container, "Steer").disabled).toBe(true);
});

test("idle composer keeps Shift+Enter as a newline", () => {
  const { container, controller } = mountedSessionDetail(TEST_SESSION_DETAIL);
  const send = vi.spyOn(controller, "send").mockResolvedValue();
  const continueSession = vi
    .spyOn(controller, "continueSession")
    .mockResolvedValue();
  const composer = textarea(container);

  const newline = keyDown(composer, { key: "Enter", shiftKey: true });

  expect(newline.defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect(continueSession).not.toHaveBeenCalled();
});
// cpd-ignore-end
