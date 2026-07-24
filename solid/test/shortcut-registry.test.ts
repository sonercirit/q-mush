import { describe, expect, test } from "vitest";
import {
  APPLICATION_SHORTCUTS,
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
  shortcutAriaKey,
  shortcutDefinition,
  shortcutDisplayLabel,
  shortcutRegistryApi,
  type ShortcutDefinition,
  type ShortcutKey,
} from "../../solid/shortcut-registry.ts";

function keyboardEvent(
  values: Partial<
    Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">
  >,
): Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"> {
  return {
    altKey: false,
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...values,
  };
}

describe("keyboard shortcut definitions", () => {
  test("has one conflict-free authoritative application registry", () => {
    expect(() => {
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .assertNoShortcutConflicts(APPLICATION_SHORTCUTS);
    }).not.toThrow();
    expect(APPLICATION_SHORTCUTS.map(({ action }) => action).sort()).toEqual(
      Object.values(SHORTCUT_ACTIONS).sort(),
    );
  });

  test("rejects two actions with the same keys in one scope", () => {
    const conflicting: readonly ShortcutDefinition[] = [
      {
        action: "first",
        context: "Test view",
        input: "ignore",
        keys: [
          shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
            .submit,
        ],
        label: "First action",
        layer: "scoped",
        scope: "test-view",
      },
      {
        action: "second",
        context: "Test view",
        input: "ignore",
        keys: [
          shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
            .submit,
        ],
        label: "Second action",
        layer: "scoped",
        scope: "test-view",
      },
    ];

    expect(() => {
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .assertNoShortcutConflicts(conflicting);
    }).toThrow(/First action.*Second action/u);
  });

  test("rejects platform-resolved conflicts and malformed primary bindings", () => {
    const malformed: readonly ShortcutDefinition[] = [
      {
        action: "malformed",
        context: "Test view",
        input: "ignore",
        keys: [{ ctrl: true, key: "Enter", primary: true }],
        label: "Malformed action",
        layer: "scoped",
        scope: "test-view",
      },
    ];

    expect(() => {
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .assertNoShortcutConflicts(malformed);
    }).toThrow(/combines primary/u);

    const platformConflict: readonly ShortcutDefinition[] = [
      {
        action: "primary",
        context: "Test view",
        input: "ignore",
        keys: [{ key: "Enter", primary: true }],
        label: "Primary action",
        layer: "scoped",
        scope: "test-view",
      },
      {
        action: "control",
        context: "Test view",
        input: "ignore",
        keys: [{ ctrl: true, key: "Enter" }],
        label: "Control action",
        layer: "scoped",
        scope: "test-view",
      },
    ];
    expect(() => {
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .assertNoShortcutConflicts(platformConflict);
    }).toThrow(/Primary action.*Control action/u);
  });

  test("formats primary shortcuts for the current platform", () => {
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .detectShortcutPlatform("MacIntel"),
    ).toBe("mac");
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .detectShortcutPlatform("iPhone"),
    ).toBe("mac");
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .detectShortcutPlatform("Linux x86_64 Mozilla/5.0 (X11; Linux x86_64)"),
    ).toBe("other");
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .detectShortcutPlatform("Linux armv8l Mozilla/5.0 (Macintosh)"),
    ).toBe("mac");
    expect(
      shortcutDisplayLabel(
        shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
          .submit,
        "mac",
      ),
    ).toBe("⌘ Enter");
    expect(
      shortcutDisplayLabel(
        shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
          .submit,
        "other",
      ),
    ).toBe("Ctrl Enter");
    expect(
      shortcutAriaKey(
        shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
          .submit,
        "mac",
      ),
    ).toBe("Meta+Enter");
    expect(
      shortcutAriaKey(
        shortcutDefinition(SHORTCUT_ACTIONS.showShortcutHelp).keys[0],
        "other",
      ),
    ).toBe("Shift+/");
    expect(
      shortcutAriaKey(
        shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
          .submit,
        "other",
      ),
    ).toBe("Control+Enter");
  });

  test("assigns primary Enter and primary Shift+Enter without claiming bare Shift+Enter", () => {
    const commandEnter = keyboardEvent({ key: "Enter", metaKey: true });
    const commandShiftEnter = keyboardEvent({
      key: "Enter",
      metaKey: true,
      shiftKey: true,
    });
    const controlEnter = keyboardEvent({ ctrlKey: true, key: "Enter" });
    const controlShiftEnter = keyboardEvent({
      ctrlKey: true,
      key: "Enter",
      shiftKey: true,
    });
    const shiftEnter = keyboardEvent({ key: "Enter", shiftKey: true });
    const start = shortcutDefinition(SHORTCUT_ACTIONS.startSession);
    const followUp = shortcutDefinition(SHORTCUT_ACTIONS.sendFollowUp);
    const continueSession = shortcutDefinition(
      SHORTCUT_ACTIONS.continueSession,
    );
    const matches = (
      event: ReturnType<typeof keyboardEvent>,
      definition: { readonly keys: readonly ShortcutKey[] },
      platform: "mac" | "other",
    ): boolean =>
      definition.keys.some((key) =>
        shortcutRegistryApi
          .shortcutRegistryTestApi()
          .shortcutMatches(event, key, platform),
      );

    expect(matches(commandEnter, start, "mac")).toBe(true);
    expect(matches(controlEnter, start, "other")).toBe(true);
    expect(matches(commandEnter, followUp, "mac")).toBe(true);
    expect(matches(controlEnter, followUp, "other")).toBe(true);
    expect(matches(commandShiftEnter, continueSession, "mac")).toBe(true);
    expect(matches(controlShiftEnter, continueSession, "other")).toBe(true);
    expect(matches(shiftEnter, continueSession, "mac")).toBe(false);
    expect(matches(shiftEnter, continueSession, "other")).toBe(false);
    expect(
      APPLICATION_SHORTCUTS.some((definition) =>
        matches(shiftEnter, definition, "other"),
      ),
    ).toBe(false);
  });
});

describe("keyboard shortcut availability", () => {
  test("lists only registered actions whose predicates currently pass", () => {
    let canStart = true;
    const registry = new KeyboardShortcutRegistry({ platform: "other" });
    const removeStart = registry.register({
      action: SHORTCUT_ACTIONS.startSession,
      available: () => canStart,
      handler: () => undefined,
    });
    registry.register({
      action: SHORTCUT_ACTIONS.sendFollowUp,
      available: () => false,
      handler: () => undefined,
    });

    expect(registry.available().map(({ action }) => action)).toEqual([
      SHORTCUT_ACTIONS.startSession,
    ]);

    canStart = false;
    expect(registry.available()).toEqual([]);

    removeStart();
    canStart = true;
    expect(registry.available()).toEqual([]);
  });
});
