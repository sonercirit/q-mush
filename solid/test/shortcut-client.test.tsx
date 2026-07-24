import { expect, test } from "vitest";
import {
  APPLICATION_SHORTCUTS,
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
} from "../../solid/shortcut-registry.ts";
import { renderSolidToString } from "./render-solid.tsx";
import { SessionShortcutTestView } from "./session-shortcut-test-view.tsx";
import { ShortcutTestView } from "./shortcut-test-view.tsx";

test("renders compact shortcut hints and the active shortcut help panel", () => {
  const registry = new KeyboardShortcutRegistry({ platform: "mac" });
  registry.register({
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    available: () => true,
    handler: () => undefined,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => true,
    handler: () => undefined,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.continueSession,
    available: () => true,
    handler: () => undefined,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.sendFollowUp,
    available: () => false,
    handler: () => undefined,
  });

  const html = renderSolidToString(() => (
    <ShortcutTestView registry={registry} />
  ));

  expect(html).toContain('data-shortcut-help="true"');
  expect(html).toContain("Keyboard shortcuts");
  expect(html).toContain("Start session");
  expect(html).toContain("Continue session");
  expect(html).toContain("⌘ Enter");
  expect(html).toContain("⌘ Shift Enter");
  expect(html).toContain("New session");
  expect(html).toContain("Selected session");
  expect(html).not.toContain("Send follow-up");
  expect(html).not.toContain(">Shift Enter<");
  registry.dispose();
});

test("server rendering outside a provider remains stateless", () => {
  const first = renderSolidToString(() => <SessionShortcutTestView />);
  const second = renderSolidToString(() => <SessionShortcutTestView />);

  expect(first).toBe(second);
  expect(first).toContain('aria-keyshortcuts="Control+Enter"');
  expect(first).toContain('aria-keyshortcuts="Control+Shift+Enter"');
});

test("the help definition is discoverable and uses the question-mark key", () => {
  const help = APPLICATION_SHORTCUTS.find(
    ({ action }) => action === SHORTCUT_ACTIONS.showShortcutHelp,
  );

  expect(help).toMatchObject({
    context: "Application",
    keys: [{ key: "?", shift: true }],
    label: "Show keyboard shortcuts",
  });
});
