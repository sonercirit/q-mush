import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import { createProviderViewState } from "../provider-client.tsx";
import { createReactiveState } from "../reactive-state.ts";
import { createRunnerViewState } from "../runner-client.tsx";
import { SessionPanel, type SessionViewState } from "../session-client.tsx";
import { summaryFromDetail } from "../session-codec.ts";
import { SessionController } from "../session-controller.ts";
import { initialSessionViewState } from "../session-state.ts";
import {
  clickTestButton,
  disposeTestViews,
  findTestButton,
  mountTestView,
  queryTestElement,
  queryTestTranscript,
  setTestInputValue,
} from "./dom-test-helpers.ts";
import { runnerSummary } from "./runner-fixtures.ts";
import { sessionDetailState } from "./session-detail-test-state.ts";
import { TEST_SESSION_DETAIL } from "./session-fixtures.ts";

const focusDisposals: (() => void)[] = [];

function mountFocusPanelWithController(
  controller: SessionController,
  runners = createRunnerViewState([]),
): HTMLDivElement {
  return mountTestView(
    () => (
      <SessionPanel
        controller={controller}
        openAi={() => createProviderViewState([])}
        openRouter={() => createProviderViewState([])}
        runners={() => runners}
      />
    ),
    focusDisposals,
  );
}

function mountFocusPanel(
  sessions = [summaryFromDetail(TEST_SESSION_DETAIL)],
  runners = createRunnerViewState([]),
  selected = true,
): {
  readonly container: HTMLDivElement;
  readonly controller: SessionController;
} {
  const controller = new SessionController(
    selected
      ? sessionDetailState(TEST_SESSION_DETAIL, sessions)
      : createReactiveState<SessionViewState>({
          ...initialSessionViewState(),
          sessions,
        }),
    undefined,
    null,
  );
  const container = mountFocusPanelWithController(controller, runners);
  return { container, controller };
}

function sessionTextarea(
  container: ParentNode,
  selector: string,
): HTMLTextAreaElement {
  const element = queryTestElement(container, selector);
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new TypeError(`The session control ${selector} is not a textarea`);
  }
  return element;
}

function pendingResponse(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function dispatchEscape(): void {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

async function settleFocus(): Promise<void> {
  await Promise.resolve();
}

async function clickAndSettle(
  container: ParentNode,
  selector: string,
): Promise<void> {
  clickTestButton(container, selector);
  await settleFocus();
}

function expectClasses(element: Element, classes: readonly string[]): void {
  for (const className of classes) {
    expect(element.classList).toContain(className);
  }
}

function expectFocusMode(container: ParentNode, focused: boolean): void {
  const toggle = queryTestElement(
    container,
    "[data-session-focus-toggle='true']",
  );
  const results = queryTestElement(container, "[data-session-results='true']");
  expect(toggle.getAttribute("aria-pressed")).toBe(String(focused));
  expect(results.getAttribute("data-session-focus-mode")).toBe(String(focused));
  expect(document.body.classList.contains("session-focus-scroll-lock")).toBe(
    focused,
  );
}

function expectActiveTestElement(
  container: ParentNode,
  selector: string,
): void {
  expect(document.activeElement).toBe(queryTestElement(container, selector));
}

async function enterFocusMode(container: ParentNode): Promise<void> {
  await clickAndSettle(container, "[data-session-focus-toggle='true']");
  expectFocusMode(container, true);
}

async function openDrawer(container: ParentNode): Promise<void> {
  await clickAndSettle(container, "[data-session-drawer-toggle='true']");
}

function expectDrawerState(rail: Element, shell: Element, open: boolean): void {
  expect(rail.getAttribute("data-session-list-open")).toBe(String(open));
  expect(rail.hasAttribute("inert")).toBe(!open);
  expect(rail.getAttribute("aria-hidden")).toBe(open ? null : "true");
  expect(shell.hasAttribute("inert")).toBe(open);
}

function expectClosedDrawerFocusedDetail(rail: Element, shell: Element): void {
  expectDrawerState(rail, shell, false);
  expect(document.activeElement).toBe(shell);
}

function expectPreservedView(
  container: ParentNode,
  original: {
    readonly detail: Element;
    readonly followUp: HTMLTextAreaElement;
    readonly prompt: HTMLTextAreaElement;
    readonly transcript: HTMLUListElement;
  },
): void {
  expect(
    queryTestElement(container, "[data-session-detail-content='true']"),
  ).toBe(original.detail);
  expect(queryTestElement(container, "#session-prompt")).toBe(original.prompt);
  expect(queryTestTranscript(container)).toBe(original.transcript);
  expect(
    queryTestElement(
      container,
      "[data-session-composer='true'] textarea[name='prompt']",
    ),
  ).toBe(original.followUp);
  expect(original.followUp.value).toBe("Keep this draft");
}

afterEach(() => {
  disposeTestViews(focusDisposals);
});

test("session list follows the detail row and owns its overflow with or without a selection", () => {
  for (const selected of [true, false]) {
    const { container } = mountFocusPanel(
      undefined,
      createRunnerViewState([]),
      selected,
    );
    const results = queryTestElement(
      container,
      "[data-session-results='true']",
    );
    const panel = queryTestElement(results, "[data-session-list-panel='true']");
    const surface = queryTestElement(panel, ".session-list-surface");
    const list = queryTestElement(surface, ".session-list-items");

    expectClasses(results, ["auto-rows-fr", "items-stretch", "min-h-0"]);
    expectClasses(panel, [
      "min-h-0",
      "overflow-hidden",
      "relative",
      "self-stretch",
    ]);
    expectClasses(surface, [
      "absolute",
      "flex",
      "flex-col",
      "h-full",
      "inset-0",
      "min-h-0",
      "overflow-hidden",
    ]);
    expectClasses(list, ["flex-1", "min-h-0", "overflow-y-auto"]);
  }
});

test("desktop focus mode keeps an open rail above a hidden backdrop", () => {
  const styles = readFileSync(`${process.cwd()}/solid/styles.css`, "utf8");

  expect(styles).toMatch(
    /@media \(min-width: 1024px\)[\s\S]*?\.session-list-panel\[data-session-list-open="true"\]\s*\+ \.session-list-backdrop\s*\{\s*display: none;/u,
  );
});

test("focus mode keeps the mounted detail and draft controls stable", async () => {
  const { container } = mountFocusPanel();
  const original = {
    detail: queryTestElement(container, "[data-session-detail-content='true']"),
    followUp: sessionTextarea(
      container,
      "[data-session-composer='true'] textarea[name='prompt']",
    ),
    prompt: sessionTextarea(container, "#session-prompt"),
    transcript: queryTestTranscript(container),
  };
  original.followUp.value = "Keep this draft";
  original.followUp.dispatchEvent(new InputEvent("input", { bubbles: true }));
  original.transcript.scrollTop = 27;

  await enterFocusMode(container);

  expectActiveTestElement(container, "[data-session-focus-toggle='true']");
  expectPreservedView(container, original);
  expect(original.transcript.scrollTop).toBe(27);

  await clickAndSettle(container, "[data-session-focus-toggle='true']");

  expectFocusMode(container, false);
  expectPreservedView(container, original);
});

test("cap rejections stay visible beside the editor in focus mode", async () => {
  const detail = { ...TEST_SESSION_DETAIL, currentContextTokens: 50_000 };
  let rejected = false;
  const rejectionDetail =
    "The context token cap exceeds the model limit discovered by the server.";
  const command = vi.fn((operation: string) => {
    if (operation !== "sessions.set_context_token_cap") {
      throw new Error(`Unexpected command: ${operation}`);
    }
    rejected = true;
    return Promise.reject(
      Object.assign(new Error(rejectionDetail), {
        code: "invalid_context_token_cap",
      }),
    );
  });
  const reactive = sessionDetailState(detail, [summaryFromDetail(detail)]);
  const controllerArguments = [reactive, undefined, null, { command }] as const;
  const controller = new SessionController(...controllerArguments);
  const container = mountFocusPanelWithController(controller);
  await enterFocusMode(container);
  const input = container.querySelector<HTMLInputElement>(
    "#session-detail-context-token-cap",
  );
  if (input === null) throw new TypeError("Detail cap field was not rendered");
  setTestInputValue(input, "64000");
  findTestButton(container, "Save cap")?.click();

  await vi.waitFor(() => {
    const localText = input.closest("form")?.textContent;
    if (!localText?.includes(rejectionDetail)) {
      throw new Error("The local cap rejection is not visible");
    }
    expect({
      focused: queryTestElement(
        container,
        "[data-session-focus-toggle='true']",
      ).getAttribute("aria-pressed"),
      rejected,
    }).toEqual({ focused: "true", rejected: true });
  });
});

test("focus mode manages its session drawer, focus, Escape, and resize", async () => {
  const second = {
    ...TEST_SESSION_DETAIL,
    id: "session-2",
    title: "Second task",
    updatedAt: 3,
  };
  const { container, controller } = mountFocusPanel([
    summaryFromDetail(TEST_SESSION_DETAIL),
    summaryFromDetail(second),
  ]);
  const select = vi.spyOn(controller, "select").mockResolvedValue();
  await enterFocusMode(container);
  const rail = queryTestElement(container, "[data-session-list-panel='true']");
  const detail = queryTestElement(
    container,
    "[data-session-detail-content='true']",
  );
  const shell = queryTestElement(
    container,
    "[data-session-detail-shell='true']",
  );
  const edgeTrigger = queryTestElement(
    container,
    "[data-session-list-edge-trigger='true']",
  );
  const drawerToggle = queryTestElement(
    container,
    "[data-session-drawer-toggle='true']",
  );

  expectDrawerState(rail, shell, false);
  await openDrawer(container);
  expectDrawerState(rail, shell, true);
  expect(drawerToggle.getAttribute("aria-expanded")).toBe("true");
  expectActiveTestElement(container, "[data-session-id='session-1']");

  await clickAndSettle(container, "[data-session-id='session-2']");
  expect(select).toHaveBeenCalledWith("session-2");
  expectClosedDrawerFocusedDetail(rail, shell);

  await openDrawer(container);
  window.dispatchEvent(new Event("resize"));
  await settleFocus();
  expectClosedDrawerFocusedDetail(rail, shell);

  edgeTrigger.dispatchEvent(new MouseEvent("mouseenter"));
  expectDrawerState(rail, shell, true);
  rail.dispatchEvent(new MouseEvent("mouseleave"));
  await settleFocus();
  expectDrawerState(rail, shell, false);

  await openDrawer(container);
  expect(
    queryTestElement(container, "[data-session-detail-content='true']"),
  ).toBe(detail);

  dispatchEscape();
  await settleFocus();
  expectClosedDrawerFocusedDetail(rail, shell);
  expectFocusMode(container, true);

  dispatchEscape();
  await settleFocus();
  expectFocusMode(container, false);
  expectActiveTestElement(container, "[data-session-focus-toggle='true']");
});

test("opening the directory picker leaves focus mode and restores Browse focus", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => pendingResponse(), {
    preconnect: originalFetch.preconnect,
  });
  focusDisposals.push(() => {
    globalThis.fetch = originalFetch;
  });
  const { container } = mountFocusPanel(
    undefined,
    createRunnerViewState([{ ...runnerSummary(1), isDefault: true }]),
  );
  const directory = queryTestElement(container, "#session-directory");
  const browse =
    directory.parentElement?.parentElement?.querySelector("button");
  if (!(browse instanceof HTMLButtonElement)) {
    throw new TypeError("The directory picker control is not a button");
  }
  browse.disabled = false;
  browse.focus();
  await enterFocusMode(container);

  browse.click();
  await settleFocus();

  expectFocusMode(container, false);
  const dialog = queryTestElement(container, "[data-directory-picker='true']");
  expect(document.activeElement).toBe(dialog);

  await clickAndSettle(
    container,
    "button[aria-label='Close directory picker']",
  );

  expectActiveTestElement(container, "[data-session-focus-toggle='true']");
});
