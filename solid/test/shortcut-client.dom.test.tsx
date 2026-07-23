import { render } from "solid-js/web";
import { afterEach, expect, test } from "vitest";
import { ShortcutProvider } from "../../solid/shortcut-client.tsx";
import { KeyboardShortcutRegistry } from "../../solid/shortcut-registry.ts";
import { shortcutKeyEvent } from "./shortcut-test-helpers.ts";

let registry: KeyboardShortcutRegistry | undefined;

afterEach(() => {
  registry?.dispose();
  registry = undefined;
  document.body.replaceChildren();
});

test("question mark toggles a visible accessible responsive help dialog", async () => {
  const activeRegistry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  registry = activeRegistry;
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(
    () => (
      <ShortcutProvider registry={activeRegistry}>
        <main>Workspace</main>
      </ShortcutProvider>
    ),
    container,
  );

  shortcutKeyEvent(document.body, "?");

  const dialog = container.querySelector("[data-shortcut-help='true']");
  expect(dialog).not.toBeNull();
  expect(dialog?.getAttribute("role")).toBe("dialog");
  expect(dialog?.getAttribute("aria-modal")).toBe("true");
  expect(dialog?.className).toContain("p-4");
  expect(dialog?.textContent).toContain("Show keyboard shortcuts");
  await Promise.resolve();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Close keyboard shortcuts",
  );

  shortcutKeyEvent(document.body, "?");
  expect(container.querySelector("[data-shortcut-help='true']")).toBeNull();
  dispose();
});
