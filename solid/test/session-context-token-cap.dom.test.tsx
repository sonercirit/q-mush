import { expect, test, vi } from "vitest";
import { SESSION_REALTIME_OPERATIONS } from "../../shared/user-realtime-protocol.ts";
import { createReactiveState } from "../reactive-state.ts";
import { updateSessionContextTokenCap } from "../session-controller-context-cap.ts";
import { initialSessionViewState } from "../session-state.ts";
import type { SessionViewState } from "../session-view-state.ts";
import {
  clickTestButton,
  findTestButton,
  queryTestElement,
  queryTestElementAs,
} from "./dom-test-helpers.ts";
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

function mountCapDetail(detail: ReturnType<typeof contextCapDetail>) {
  const command = capCommand(detail);
  const mounted = mountSessionDetailBody(
    sessionDetailState(detail),
    disposals,
    {
      command,
    },
  );
  clickTestButton(mounted.container, "[data-session-cap-toggle='true']");
  return { ...mounted, command, detail };
}

function mountCapEditor(autoCompact = true) {
  return mountCapDetail(contextCapDetail(autoCompact));
}

function capInput(container: ParentNode): HTMLInputElement {
  return queryTestElementAs(
    container,
    "#session-detail-context-token-cap",
    HTMLInputElement,
  );
}

function setInput(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function submitCap(container: ParentNode, value: string): void {
  setInput(capInput(container), value);
  findTestButton(container, "Save cap")?.click();
}

function capEditor(container: ParentNode): HTMLFormElement | null {
  return capInput(container).closest("form");
}

test("raises a cap within the underlying model limit", async () => {
  const detail = {
    ...contextCapDetail(false),
    currentContextTokens: 100_000,
    maxContextTokens: 120_000,
    modelContextTokens: 200_000,
    userContextTokenCap: 120_000,
  };
  const raisedView = mountCapDetail(detail);
  submitCap(raisedView.container, "150000");

  await vi.waitFor(() => {
    expect(raisedView.command).toHaveBeenCalledWith(
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: detail.id, userContextTokenCap: 150_000 },
    );
  });
});

test("rejects a cap above the underlying model limit", () => {
  const detail = {
    ...contextCapDetail(false),
    maxContextTokens: 120_000,
    modelContextTokens: 200_000,
    userContextTokenCap: 120_000,
  };
  const rejectedView = mountCapDetail(detail);
  submitCap(rejectedView.container, "200001");

  expect(rejectedView.command).not.toHaveBeenCalled();
  expect(capEditor(rejectedView.container)?.textContent).toContain(
    "cannot exceed the model limit of 200,000 tokens",
  );
});

test("warns before applying an already exceeded cap", async () => {
  const warningView = mountCapEditor();
  submitCap(warningView.container, "120000");

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

test("shows the server rejection beside the cap editor", async () => {
  const detail = contextCapDetail(true);
  const rejectionDetail =
    "The context token cap exceeds the newly discovered model limit.";
  const failure = Object.assign(new Error(rejectionDetail), {
    code: "invalid_context_token_cap",
  });
  const command = vi.fn(() => Promise.reject(failure));
  const rejectedView = mountSessionDetailBody(
    sessionDetailState(detail),
    disposals,
    { command },
  );
  clickTestButton(rejectedView.container, "[data-session-cap-toggle='true']");
  submitCap(rejectedView.container, "160000");

  await vi.waitFor(() => {
    expect(capEditor(rejectedView.container)?.textContent).toContain(
      rejectionDetail,
    );
  });
});

test("applies an exceeded cap directly when auto-compact is off", async () => {
  const manualView = mountCapEditor(false);
  submitCap(manualView.container, "120000");

  expect(
    manualView.container.querySelector(
      "[data-context-token-cap-dialog='true']",
    ),
  ).toBeNull();
  await vi.waitFor(() => {
    expect(manualView.command).toHaveBeenCalledTimes(1);
    expect(manualView.command).toHaveBeenCalledWith(
      SESSION_REALTIME_OPERATIONS.setContextTokenCap,
      { sessionId: manualView.detail.id, userContextTokenCap: 120_000 },
    );
  });
  expect(manualView.command).not.toHaveBeenCalledWith(
    SESSION_REALTIME_OPERATIONS.compact,
    expect.anything(),
  );
});

test.each([
  { currentContextTokens: 150_000, status: "running" as const },
  { currentContextTokens: 100_000, status: "idle" as const },
])(
  "rechecks live status and usage before launching compaction %#",
  async (changes) => {
    const detail = contextCapDetail(true);
    const reactive = createReactiveState<SessionViewState>({
      ...initialSessionViewState(),
      detail,
      selectedId: detail.id,
    });
    const compact = vi.fn(() => Promise.resolve());
    const mutate = vi.fn(() => {
      reactive.setState((state) => ({
        ...state,
        detail: {
          ...detail,
          ...changes,
          userContextTokenCap: 120_000,
        },
      }));
      return Promise.resolve();
    });

    await updateSessionContextTokenCap(
      {
        compact,
        mutateContextTokenCap: mutate,
        view: reactive.state,
      },
      120_000,
      true,
    );

    expect(mutate).toHaveBeenCalledOnce();
    expect(compact).not.toHaveBeenCalled();
  },
);

test("keeps cap controls collapsed until expanded and hides them again", () => {
  const detail = contextCapDetail(false);
  const command = capCommand(detail);
  const { container } = mountSessionDetailBody(
    sessionDetailState(detail),
    disposals,
    { command },
  );
  const description =
    "Cap the context tokens available to future turns. Leave blank to restore the model limit.";
  const collapsedState = {
    described: false,
    input: null,
    save: undefined,
  };
  const capState = () => ({
    described: container.textContent.includes(description),
    input: container.querySelector("#session-detail-context-token-cap"),
    save: findTestButton(container, "Save cap"),
  });

  expect(capState()).toEqual(collapsedState);

  clickTestButton(container, "[data-session-cap-toggle='true']");
  expect(
    container
      .querySelector("[data-session-cap-toggle='true']")
      ?.getAttribute("aria-label"),
  ).toBe("Collapse Context token cap");
  const expanded = capState();
  expect(expanded.described).toBe(true);
  expect(expanded.input).toBeInstanceOf(HTMLInputElement);
  expect(expanded.save).toBeInstanceOf(HTMLButtonElement);

  clickTestButton(container, "[data-session-cap-toggle='true']");
  expect(capState()).toEqual(collapsedState);
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
