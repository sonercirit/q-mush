import { afterEach, expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import {
  disposeTestViews,
  findTestButton,
  queryTestElement,
} from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { mountSessionDetailBody } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const disposals = new Array<() => void>();
afterEach(() => disposeTestViews(disposals));

function mountCapEditor(autoCompact = true) {
  const detail = {
    ...TEST_SESSION_DETAIL,
    autoCompact,
    currentContextTokens: 150_000,
  };
  const command = vi.fn(
    (operation: string, payload: Readonly<Record<string, unknown>>) => {
      if (operation === SESSION_REALTIME_OPERATIONS.setContextTokenCap) {
        return Promise.resolve({
          ...detail,
          maxContextTokens: payload["userContextTokenCap"] ?? 200_000,
          updatedAt: detail.updatedAt + 1,
          userContextTokenCap: payload["userContextTokenCap"],
        });
      }
      if (operation === SESSION_REALTIME_OPERATIONS.compact) {
        return Promise.resolve({
          ...detail,
          generation: detail.generation + 1,
          status: "queued" as const,
          updatedAt: detail.updatedAt + 2,
        });
      }
      return Promise.reject(new Error("Unexpected command"));
    },
  );
  return {
    ...mountSessionDetailBody(sessionDetailState(detail), disposals, {
      command,
    }),
    command,
    detail,
  };
}

function capInput(container: ParentNode): HTMLInputElement {
  const input = queryTestElement(
    container,
    "#session-detail-context-token-cap",
  );
  if (!(input instanceof HTMLInputElement))
    throw new TypeError("Missing cap input");
  return input;
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

test("warns before applying an already exceeded cap", async () => {
  const mounted = mountCapEditor();
  setInput(capInput(mounted.container), "120000");
  findTestButton(mounted.container, "Save cap")?.click();

  const dialog = queryTestElement(
    mounted.container,
    "[data-context-token-cap-dialog='true']",
  );
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.textContent).toContain(
    "Automatic compaction will trigger first",
  );
  expect(mounted.command).not.toHaveBeenCalled();

  findTestButton(dialog, "Apply cap")?.click();
  await vi.waitFor(() => {
    expect(mounted.command).toHaveBeenNthCalledWith(
      1,
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: mounted.detail.id, userContextTokenCap: 120_000 },
    );
    expect(mounted.command).toHaveBeenNthCalledWith(
      2,
      SESSION_REALTIME_OPERATIONS.compact,
      { sessionId: mounted.detail.id },
    );
  });
});

test("applies an exceeded cap without compaction when auto-compact is off", async () => {
  const mounted = mountCapEditor(false);
  setInput(capInput(mounted.container), "120000");
  findTestButton(mounted.container, "Save cap")?.click();
  findTestButton(mounted.container, "Apply cap")?.click();

  await vi.waitFor(() => expect(mounted.command).toHaveBeenCalledTimes(1));
  expect(mounted.command).not.toHaveBeenCalledWith(
    SESSION_REALTIME_OPERATIONS.compact,
    expect.anything(),
  );
});

test("clearing the cap restores the model limit", async () => {
  const mounted = mountCapEditor();
  setInput(capInput(mounted.container), "");
  findTestButton(mounted.container, "Save cap")?.click();

  await vi.waitFor(() => {
    expect(mounted.command).toHaveBeenCalledWith(
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: mounted.detail.id, userContextTokenCap: null },
    );
  });
});
