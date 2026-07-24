import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { DirectoryPicker } from "../../solid/directory-picker-client.tsx";
import {
  DirectoryPickerController,
  initialDirectoryPickerState,
  type DirectoryPickerState,
} from "../../solid/directory-picker-controller.ts";
import { createReactiveState } from "../../solid/reactive-state.ts";
import { ShortcutProvider } from "../../solid/shortcut-client.tsx";
import {
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
} from "../../solid/shortcut-registry.ts";
import { shortcutKeyEvent } from "./shortcut-test-helpers.ts";

const disposals: (() => void)[] = [];

function createRegistry(): KeyboardShortcutRegistry {
  const registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  disposals.push(() => {
    registry.dispose();
  });
  return registry;
}

function mountProvider(registry: KeyboardShortcutRegistry): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(
    render(
      () => (
        <ShortcutProvider registry={registry}>
          <main>Workspace</main>
        </ShortcutProvider>
      ),
      container,
    ),
  );
  return container;
}

afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) {
    dispose();
  }
  document.body.replaceChildren();
});

test("question mark opens a visible accessible responsive help dialog", async () => {
  const container = mountProvider(createRegistry());
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();

  shortcutKeyEvent(document.body, "?", { shiftKey: true });

  const dialog = container.querySelector("[data-shortcut-help='true']");
  const background = container.querySelector(".contents");
  expect(dialog).not.toBeNull();
  expect(background?.hasAttribute("inert")).toBe(true);
  expect(dialog?.getAttribute("role")).toBe("dialog");
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(dialog?.getAttribute("tabindex")).toBe("-1");
  expect(dialog?.className).toContain("p-4");
  expect(dialog?.textContent).toContain("Show keyboard shortcuts");
  expect(dialog?.textContent).not.toContain("Start session");
  expect(dialog?.textContent).not.toContain("Send follow-up");
  expect(dialog?.textContent).not.toContain("Continue session");
  await Promise.resolve();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Close keyboard shortcuts",
  );

  const secondQuestion = shortcutKeyEvent(document.body, "?", {
    shiftKey: true,
  });
  expect(secondQuestion.defaultPrevented).toBe(false);
  expect(container.querySelector("[data-shortcut-help='true']")).not.toBeNull();
  const escape = shortcutKeyEvent(document.body, "Escape");
  expect(escape.defaultPrevented).toBe(true);
  expect(container.querySelector("[data-shortcut-help='true']")).toBeNull();
  expect(background?.hasAttribute("inert")).toBe(false);
  await Promise.resolve();
  expect(document.activeElement).toBe(opener);
});

test("help traps focus and closes on Escape", async () => {
  const container = mountProvider(createRegistry());

  shortcutKeyEvent(document.body, "?", { shiftKey: true });
  await Promise.resolve();
  const close = container.querySelector<HTMLButtonElement>(
    "[aria-label='Close keyboard shortcuts']",
  );
  if (close === null) {
    throw new TypeError("The shortcut dialog did not render");
  }

  const tab = shortcutKeyEvent(close, "Tab");
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);

  const escape = shortcutKeyEvent(close, "Escape");
  expect(escape.defaultPrevented).toBe(true);
  expect(container.querySelector("[data-shortcut-help='true']")).toBeNull();
});

test("directory modal blocks help and handles Escape without collisions", () => {
  const registry = createRegistry();
  let directoryOpen = true;
  registry.register({
    action: SHORTCUT_ACTIONS.closeDirectoryPicker,
    available: () => directoryOpen,
    handler: () => {
      directoryOpen = false;
    },
  });
  const container = mountProvider(registry);

  shortcutKeyEvent(document.body, "?", { shiftKey: true });
  const dialog = container.querySelector("[data-shortcut-help='true']");
  expect(registry.available().map(({ action }) => action)).toEqual([
    SHORTCUT_ACTIONS.closeDirectoryPicker,
  ]);
  const escape = shortcutKeyEvent(document.body, "Escape");

  expect(dialog).toBeNull();
  expect(escape.defaultPrevented).toBe(true);
  expect(directoryOpen).toBe(false);
});

test("directory picker restores focus after closing", () => {
  const view = createReactiveState<DirectoryPickerState>({
    ...initialDirectoryPickerState(),
    open: true,
    runnerId: "runner-1",
  });
  const controller = new DirectoryPickerController(view);
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const registry = createRegistry();
  const container = document.createElement("div");
  document.body.append(container);
  disposals.push(
    render(
      (): JSX.Element => (
        <ShortcutProvider registry={registry}>
          <DirectoryPicker
            controller={controller}
            onChoose={() => undefined}
            runnerName="Runner"
          />
        </ShortcutProvider>
      ),
      container,
    ),
  );

  expect(document.activeElement).not.toBe(opener);
  shortcutKeyEvent(document.activeElement ?? document.body, "Escape");
  expect(document.activeElement).toBe(opener);
});

test("disposing a provider does not dispose an injected registry", () => {
  const registry = createRegistry();
  const container = mountProvider(registry);
  disposals.pop()?.();

  const handler = (): void => undefined;
  expect(() =>
    registry.register({
      action: SHORTCUT_ACTIONS.startSession,
      available: () => true,
      handler,
    }),
  ).not.toThrow();
  container.remove();
});
