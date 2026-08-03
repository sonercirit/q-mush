import { expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { findTestButton, queryTestElement } from "./dom-test-helpers.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { mountSessionDetailBody } from "./session-dom-test-helpers.tsx";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";
import { testDisposals } from "./test-disposals.ts";

const disposals = testDisposals();

function contextCapDetail(autoCompact: boolean) {
  return {
    ...TEST_SESSION_DETAIL,
    autoCompact,
    currentContextTokens: 150_000,
  };
}

function capCommand(detail: ReturnType<typeof contextCapDetail>) {
  const execute = (
    operation: string,
    payload: Readonly<Record<string, unknown>>,
  ) => {
    if (operation === SESSION_REALTIME_OPERATIONS.setContextTokenCap) {
      return Promise.resolve({
        ...detail,
        maxContextTokens: payload["userContextTokenCap"] ?? 200_000,
        updatedAt: detail.updatedAt + 1,
        userContextTokenCap: payload["userContextTokenCap"],
      });
    }
    if (operation === SESSION_REALTIME_OPERATIONS.compact) {
      const queued = Object.assign({}, detail, {
        generation: detail.generation + 1,
        status: detail.status === "idle" ? ("queued" as const) : detail.status,
        updatedAt: detail.updatedAt + 2,
      });
      return Promise.resolve(queued);
    }
    return Promise.reject(new Error("Unexpected command"));
  };
  const command = vi.fn(execute);
  command.mockName("context token cap command");
  return command;
}

function mountCapEditor(autoCompact = true) {
  const detail = contextCapDetail(autoCompact);
  const command = capCommand(detail);
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
  const warningView = mountCapEditor();
  setInput(capInput(warningView.container), "120000");
  findTestButton(warningView.container, "Save cap")?.click();

  const dialog = queryTestElement(
    warningView.container,
    "[data-context-token-cap-dialog='true']",
  );
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.textContent).toContain(
    "Automatic compaction will trigger first",
  );
  expect(warningView.command).not.toHaveBeenCalled();

  findTestButton(dialog, "Apply cap")?.click();
  await vi.waitFor(() => {
    expect(warningView.command).toHaveBeenNthCalledWith(
      1,
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: warningView.detail.id, userContextTokenCap: 120_000 },
    );
    expect(warningView.command).toHaveBeenNthCalledWith(
      2,
      SESSION_REALTIME_OPERATIONS.compact,
      { sessionId: warningView.detail.id },
    );
  });
});

test("applies an exceeded cap without compaction when auto-compact is off", async () => {
  const manualView = mountCapEditor(false);
  setInput(capInput(manualView.container), "120000");
  findTestButton(manualView.container, "Save cap")?.click();
  findTestButton(manualView.container, "Apply cap")?.click();

  await vi.waitFor(() => {
    expect(manualView.command).toHaveBeenCalledTimes(1);
  });
  expect(manualView.command).not.toHaveBeenCalledWith(
    SESSION_REALTIME_OPERATIONS.compact,
    expect.anything(),
  );
});

test("clearing the cap restores the model limit", async () => {
  const clearedView = mountCapEditor();
  setInput(capInput(clearedView.container), "");
  findTestButton(clearedView.container, "Save cap")?.click();

  await vi.waitFor(() => {
    expect(clearedView.command).toHaveBeenCalledWith(
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: clearedView.detail.id, userContextTokenCap: null },
    );
  });
});
