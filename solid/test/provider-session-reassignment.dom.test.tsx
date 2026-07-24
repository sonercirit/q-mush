import { afterEach, expect, test, vi } from "vitest";
import { providerCredentialSessionReassignmentPath } from "../../shared/routes.ts";
import {
  OPENAI_PANEL,
  ProviderPanel,
  createProviderViewState,
  type ProviderCredential,
} from "../provider-client.tsx";
import { ProviderController } from "../provider-controller.ts";
import { createReactiveState } from "../reactive-state.ts";
import { mountDomView, type MountedDomView } from "./dom-view-fixtures.tsx";

const CREDENTIAL: ProviderCredential = {
  accountId: "account-1",
  id: "credential-1",
  isDefault: true,
  label: "Primary account",
  source: "oauth",
};
const mounted: MountedDomView[] = [];

function mount(): {
  readonly container: HTMLElement;
  readonly controller: ProviderController;
} {
  const controller = new ProviderController(
    OPENAI_PANEL,
    createReactiveState(createProviderViewState([CREDENTIAL])),
  );
  const view = mountDomView(() => (
    <ProviderPanel configuration={OPENAI_PANEL} controller={controller} />
  ));
  mounted.push(view);
  return { container: view.container, controller };
}

function button(
  container: ParentNode,
  text: string,
  ariaLabel = false,
): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) =>
    ariaLabel
      ? candidate.getAttribute("aria-label") === text
      : candidate.textContent.trim() === text,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new TypeError(`Missing button: ${text}`);
  }
  return found;
}

function clickAction(container: ParentNode, text: string): void {
  button(container, text).click();
}

function openReassignment(container: ParentNode): void {
  clickAction(container, "Switch sessions to this account");
}

function confirmReassignment(container: ParentNode): void {
  clickAction(container, "Switch sessions");
}

function dialog(container: ParentNode): HTMLElement {
  const found = container.querySelector("[role='dialog']");
  if (!(found instanceof HTMLElement)) {
    throw new TypeError("The session reassignment dialog was not rendered");
  }
  return found;
}

interface DeferredResponse {
  readonly promise: Promise<Response>;
  readonly resolve: (response: Response) => void;
}

function deferredResponse(): DeferredResponse {
  let resolve: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((available) => {
    resolve = available;
  });
  if (resolve === undefined) {
    throw new Error("The response promise was not initialized");
  }
  return { promise, resolve };
}

function installDeferredFetch(request: DeferredResponse): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => request.promise);
}

function clearMountedViews(): void {
  while (mounted.length > 0) {
    const view = mounted.pop();
    view?.dispose();
    view?.container.remove();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  clearMountedViews();
});

test("requires confirmation and cancel, Escape, close, or backdrop do not mutate", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  const { container } = mount();
  const trigger = button(container, "Switch sessions to this account");

  for (const closeDialog of [
    () => {
      button(container, "Cancel").click();
    },
    () => {
      button(container, "Close session reassignment dialog", true).click();
    },
    () => {
      const escape = new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      });
      window.dispatchEvent(escape);
    },
    () => {
      dialog(container).dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    },
  ]) {
    trigger.click();
    expect(dialog(container).getAttribute("aria-modal")).toBe("true");
    closeDialog();
    await Promise.resolve();
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(trigger.matches(":focus")).toBe(true);
  }
  expect(fetch).not.toHaveBeenCalled();
});

function dispatchTab(shiftKey = false): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "Tab", shiftKey }),
  );
}

test("describes exact scope and traps focus for keyboard users", async () => {
  const { container } = mount();
  const trigger = button(container, "Switch sessions to this account");
  trigger.focus();
  trigger.click();
  await Promise.resolve();

  const modal = dialog(container);
  expect(modal.getAttribute("aria-labelledby")).toBeTruthy();
  expect(modal.getAttribute("aria-describedby")).toBeTruthy();
  expect(modal.textContent).toContain(
    "All current and old non-deleted sessions stored as OpenAI",
  );
  expect(modal.textContent).toContain("queued, running, stopped, and failed");
  expect(modal.textContent).toContain("other providers will be untouched");
  expect(modal.textContent).toContain("default account will not change");

  const first = button(container, "Close session reassignment dialog", true);
  const last = button(container, "Switch sessions");
  last.focus();
  dispatchTab();
  expect(document.activeElement).toBe(first);
  first.focus();
  dispatchTab(true);
  expect(document.activeElement).toBe(last);
});

async function expectText(container: ParentNode, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(container.textContent).toContain(text);
  });
}

function expectRecoverableDialog(container: ParentNode): void {
  expect(dialog(container).textContent).toContain(
    "We could not switch your OpenAI sessions",
  );
  expect(button(container, "Switch sessions").disabled).toBe(false);
}

test("posts once to the dedicated endpoint, validates the result, and reports counts", async () => {
  const request = deferredResponse();
  installDeferredFetch(request);
  const fetch = vi.mocked(globalThis.fetch);
  const { container } = mount();
  openReassignment(container);
  confirmReassignment(container);

  const pending = button(container, "Switching sessions…");
  expect(pending.disabled).toBe(true);
  dispatchTab();
  expect(document.activeElement).toBe(dialog(container));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  dialog(container);
  pending.click();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    providerCredentialSessionReassignmentPath(
      OPENAI_PANEL.credentialsPath,
      CREDENTIAL.id,
    ),
    expect.objectContaining({
      body: "{}",
      method: "POST",
    }),
  );

  request.resolve(Response.json({ migratedSessionCount: 2 }));
  await expectText(container, "2 sessions switched to this account.");
  expect(container.querySelector("[role='dialog']")).toBeNull();
});

test("does not restore reassignment state after a workspace reset", async () => {
  const request = deferredResponse();
  installDeferredFetch(request);
  const { container, controller } = mount();
  const confirm = controller.confirmSessionReassignment.bind(controller);
  let reassignment: Promise<void> | undefined;
  vi.spyOn(controller, "confirmSessionReassignment").mockImplementation(
    async (dialog) => {
      reassignment = confirm(dialog);
      await reassignment;
    },
  );
  openReassignment(container);
  confirmReassignment(container);
  if (reassignment === undefined) {
    throw new Error("The reassignment request was not started");
  }

  controller.reset();
  expect(container.querySelector("[role='dialog']")).toBeNull();
  request.resolve(Response.json({ migratedSessionCount: 3 }));
  await reassignment;

  expect(controller.state).toEqual(createProviderViewState(undefined));
  expect(container.textContent).not.toContain(
    "3 sessions switched to this account.",
  );
});

test("reports zero honestly and keeps invalid or failed responses recoverable", async () => {
  const responses = [
    Response.json({ migratedSessionCount: 0 }),
    Response.json({ migratedSessionCount: -1 }),
    Response.json({ error: "not_found" }, { status: 404 }),
  ];
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    const response = responses.shift();
    return Promise.resolve(response ?? Response.error());
  });
  const { container } = mount();
  const executeReassignment = (): void => {
    openReassignment(container);
    confirmReassignment(container);
  };

  executeReassignment();
  await expectText(container, "No sessions needed switching");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    executeReassignment();
    await vi.waitFor(() => {
      expectRecoverableDialog(container);
    });
    button(container, "Cancel").click();
  }
});
