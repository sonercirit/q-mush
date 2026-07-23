import { afterEach, expect, test, vi } from "vitest";
import {
  KeyboardShortcutRegistry,
  SHORTCUT_ACTIONS,
} from "../../solid/shortcut-registry.ts";
import { shortcutInput, shortcutKeyEvent } from "./shortcut-test-helpers.ts";

let registry: KeyboardShortcutRegistry | undefined;

afterEach(() => {
  registry?.dispose();
  registry = undefined;
  document.body.replaceChildren();
});

test("dispatches the most specific available action and prevents its default", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const outer = vi.fn();
  const inner = vi.fn();
  const composer = shortcutInput("textarea");
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => true,
    handler: outer,
    target: () => composer,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.sendFollowUp,
    available: () => true,
    handler: inner,
    target: () => composer,
  });

  const event = shortcutKeyEvent(composer, "Enter", { ctrlKey: true });

  expect(inner).toHaveBeenCalledOnce();
  expect(outer).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
});

test("does not fire pending or disabled actions", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  let available = false;
  const composer = shortcutInput("textarea");
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => available,
    handler,
    target: () => composer,
  });

  const disabledEvent = shortcutKeyEvent(composer, "Enter", { ctrlKey: true });
  available = true;
  const enabledEvent = shortcutKeyEvent(composer, "Enter", { ctrlKey: true });

  expect(handler).toHaveBeenCalledOnce();
  expect(disabledEvent.defaultPrevented).toBe(false);
  expect(enabledEvent.defaultPrevented).toBe(true);
});

test("is IME safe", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.sendFollowUp,
    available: () => true,
    handler,
  });

  const composing = shortcutKeyEvent(document.body, "Enter", {
    ctrlKey: true,
    isComposing: true,
  });
  const process = shortcutKeyEvent(document.body, "Process", { ctrlKey: true });
  const legacyComposition = shortcutKeyEvent(document.body, "Unidentified", {
    ctrlKey: true,
    keyCode: 229,
  });

  expect(handler).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false);
  expect(process.defaultPrevented).toBe(false);
  expect(legacyComposition.defaultPrevented).toBe(false);
});

test("allows composer shortcuts only in an owned editable target", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const composer = shortcutInput("textarea");
  const unrelated = shortcutInput("input");
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => true,
    handler,
    target: () => composer,
  });

  const unrelatedEvent = shortcutKeyEvent(unrelated, "Enter", {
    ctrlKey: true,
  });
  const composerEvent = shortcutKeyEvent(composer, "Enter", { ctrlKey: true });

  expect(handler).toHaveBeenCalledOnce();
  expect(unrelatedEvent.defaultPrevented).toBe(false);
  expect(composerEvent.defaultPrevented).toBe(true);
});

test("ignores the help shortcut in editable controls", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    available: () => true,
    handler,
  });

  const editableEvent = shortcutKeyEvent(shortcutInput("textarea"), "?");
  const pageEvent = shortcutKeyEvent(document.body, "?");

  expect(handler).toHaveBeenCalledOnce();
  expect(editableEvent.defaultPrevented).toBe(false);
  expect(pageEvent.defaultPrevented).toBe(true);
});

test("does not claim modified or repeated help keystrokes", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.showShortcutHelp,
    available: () => true,
    handler,
  });

  const controlQuestion = shortcutKeyEvent(document.body, "?", {
    ctrlKey: true,
  });
  const repeatedQuestion = shortcutKeyEvent(document.body, "?", {
    repeat: true,
  });

  expect(handler).not.toHaveBeenCalled();
  expect(controlQuestion.defaultPrevented).toBe(false);
  expect(repeatedQuestion.defaultPrevented).toBe(false);
});
