import { afterEach, expect, test, vi, type MockInstance } from "vitest";
import type { AgentSessionDetail } from "../../shared/session-model.ts";
import { summaryFromDetail } from "../session-summary-codec.ts";
import { disposeTestViews, queryTestElement } from "./dom-test-helpers.ts";
import { createSessionDetailReplacement } from "./session-detail-replacement-fixture.tsx";
import { sessionDetailState } from "./session-detail-test-state.ts";
import {
  DOM_TEST_DISPOSALS,
  mountSessionDetailBody,
} from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const FIRST_SESSION_ID = "019ffeb4-f677-7000-bfe4-8861d937cbe1";
const SECOND_SESSION_ID = "01a0109c-321c-7000-9f11-e00df41a590b";

function sessionDetail(id: string): AgentSessionDetail {
  return {
    ...TEST_SESSION_DETAIL,
    id,
    title: `Session ${id.slice(0, 8)}`,
  };
}

function sessionIdControl(container: ParentNode): {
  readonly button: HTMLButtonElement;
  readonly identity: Element;
  readonly value: HTMLElement;
} {
  const button = queryTestElement(container, "[data-copy-session-id='true']");
  const value = queryTestElement(container, "[data-session-id-value='true']");
  if (
    !(button instanceof HTMLButtonElement) ||
    !(value instanceof HTMLElement)
  ) {
    throw new TypeError("The session ID controls were not rendered accessibly");
  }
  return {
    button,
    identity: queryTestElement(container, "[data-session-identity='true']"),
    value,
  };
}

function mountIdentity(detail: AgentSessionDetail) {
  const replacement = createSessionDetailReplacement();
  const mounted = mountSessionDetailBody(
    sessionDetailState(detail, [summaryFromDetail(detail)]),
    DOM_TEST_DISPOSALS,
    undefined,
    replacement.render,
  );
  return { ...mounted, replace: replacement.replace };
}

function clickCopy(button: HTMLButtonElement): void {
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function expectCopyState(
  button: HTMLButtonElement,
  expected: "Copied!" | "Copy failed",
): void {
  expect(button.textContent).toBe(expected);
}

function mockSuccessfulClipboard(): MockInstance<Clipboard["writeText"]> {
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  writeText.mockImplementation(() => Promise.resolve());
  return writeText;
}

function delayedCopy(): {
  readonly finish: () => void;
  readonly promise: Promise<void>;
} {
  const controller = new AbortController();
  const promise = new Promise<void>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true },
    );
  });
  return {
    finish: () => {
      controller.abort();
    },
    promise,
  };
}

afterEach(() => {
  disposeTestViews(DOM_TEST_DISPOSALS);
  vi.restoreAllMocks();
});

test("shows the full selectable session ID with an accessible copy action", async () => {
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("Clipboard unavailable"));
  const { container } = mountIdentity(sessionDetail(FIRST_SESSION_ID));
  const { button, identity, value } = sessionIdControl(container);

  expect(identity.getAttribute("aria-label")).toBe("Session identity");
  expect(identity.textContent).toContain("Session ID:");
  expect(value.textContent).toBe(FIRST_SESSION_ID);
  expect(value.classList).toContain("select-text");
  expect(button.getAttribute("aria-label")).toBe("Copy session ID");
  expect(button.getAttribute("aria-live")).toBeNull();
  const feedback = queryTestElement(identity, "[role='status']");
  expect(feedback.getAttribute("aria-live")).toBe("polite");
  expect(button.textContent).toBe("Copy ID");

  clickCopy(button);
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenLastCalledWith(FIRST_SESSION_ID);
    expectCopyState(button, "Copied!");
    expect(feedback.textContent).toBe("Copied!");
  });

  clickCopy(button);
  await vi.waitFor(() => {
    expectCopyState(button, "Copy failed");
    expect(feedback.textContent).toBe("Copy failed");
  });
});

test("ignores stale clipboard outcomes after a newer copy", async () => {
  const pending = delayedCopy();
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce();
  const { container } = mountIdentity(sessionDetail(FIRST_SESSION_ID));
  const { button } = sessionIdControl(container);

  for (let copy = 0; copy < 2; copy += 1) clickCopy(button);
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledTimes(2);
    expectCopyState(button, "Copied!");
  });
  pending.finish();
  await Promise.resolve();

  expectCopyState(button, "Copied!");
});

test("updates the session ID in place across navigation and preserves copy focus", async () => {
  const writeText = mockSuccessfulClipboard();
  const { container, replace } = mountIdentity(sessionDetail(FIRST_SESSION_ID));
  const first = sessionIdControl(container);
  first.button.focus();
  clickCopy(first.button);
  await vi.waitFor(() => {
    expectCopyState(first.button, "Copied!");
  });

  replace(sessionDetail(SECOND_SESSION_ID));

  const second = sessionIdControl(container);
  expect(second.identity).toBe(first.identity);
  expect(second.value).toBe(first.value);
  expect(second.button).toBe(first.button);
  expect(second.value.textContent).toBe(SECOND_SESSION_ID);
  expect(second.button.textContent).toBe("Copy ID");
  expect(document.activeElement).toBe(second.button);

  clickCopy(second.button);
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenLastCalledWith(SECOND_SESSION_ID);
  });
});
