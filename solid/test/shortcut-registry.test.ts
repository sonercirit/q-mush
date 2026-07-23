import { describe, expect, test } from "vitest";
import {
  APPLICATION_SHORTCUTS,
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
  shortcutAriaKey,
  shortcutDisplayLabel,
  shortcutRegistryApi,
  type ShortcutDefinition,
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
        scope: "test-view",
      },
    ];

    expect(() => {
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .assertNoShortcutConflicts(conflicting);
    }).toThrow(/First action.*Second action/u);
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
        .detectShortcutPlatform("Win32"),
    ).toBe("other");
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
        shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
          .submit,
        "other",
      ),
    ).toBe("Control+Enter");
  });

  test("models primary Enter and Shift Enter independently", () => {
    const commandEnter = keyboardEvent({ key: "Enter", metaKey: true });
    const controlEnter = keyboardEvent({ ctrlKey: true, key: "Enter" });
    const shiftEnter = keyboardEvent({ key: "Enter", shiftKey: true });

    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .composerShortcutMatches(commandEnter, "submit", "mac"),
    ).toBe(true);
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .composerShortcutMatches(controlEnter, "submit", "other"),
    ).toBe(true);
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .composerShortcutMatches(shiftEnter, "steer", "other"),
    ).toBe(true);
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .shortcutMatches(
          shiftEnter,
          shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
            .submit,
          "other",
        ),
    ).toBe(false);
    expect(
      shortcutRegistryApi
        .shortcutRegistryTestApi()
        .shortcutMatches(
          controlEnter,
          shortcutRegistryApi.shortcutRegistryTestApi().composerShortcutKeys
            .steer,
          "other",
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
