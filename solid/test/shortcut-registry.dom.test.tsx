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

test("is IME and AltGr safe", () => {
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
  const legacyComposition = shortcutKeyEvent(document.body, "Enter", {
    ctrlKey: true,
    keyCode: 229,
  });
  const altGraph = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "Enter",
  });
  vi.spyOn(altGraph, "getModifierState").mockImplementation(
    (modifier) => modifier === "AltGraph",
  );
  document.body.dispatchEvent(altGraph);

  expect(handler).not.toHaveBeenCalled();
  expect(composing.defaultPrevented).toBe(false);
  expect(process.defaultPrevented).toBe(false);
  expect(legacyComposition.defaultPrevented).toBe(false);
  expect(altGraph.defaultPrevented).toBe(false);
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

  const editableEvent = shortcutKeyEvent(shortcutInput("textarea"), "?", {
    shiftKey: true,
  });
  const pageEvent = shortcutKeyEvent(document.body, "?", { shiftKey: true });

  expect(handler).toHaveBeenCalledOnce();
  expect(editableEvent.defaultPrevented).toBe(false);
  expect(pageEvent.defaultPrevented).toBe(true);
});

test("handles the real shifted question-mark key but not AltGr or repeats", () => {
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

  const shiftedQuestion = shortcutKeyEvent(document.body, "?", {
    shiftKey: true,
  });
  const controlQuestion = shortcutKeyEvent(document.body, "?", {
    ctrlKey: true,
  });
  const repeatedQuestion = shortcutKeyEvent(document.body, "?", {
    repeat: true,
    shiftKey: true,
  });

  expect(handler).toHaveBeenCalledOnce();
  expect(shiftedQuestion.defaultPrevented).toBe(true);
  expect(controlQuestion.defaultPrevented).toBe(false);
  expect(repeatedQuestion.defaultPrevented).toBe(false);
});

test("stops propagation only when an enabled action handles the event", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  let available = false;
  const composer = shortcutInput("textarea");
  const bubbled = vi.fn();
  document.body.addEventListener("keydown", bubbled);
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => available,
    handler: () => undefined,
    target: () => composer,
  });
  const disabled = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "Enter",
  });
  const disabledStop = vi.spyOn(disabled, "stopPropagation");
  composer.dispatchEvent(disabled);
  available = true;
  const enabled = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "Enter",
  });
  const enabledStop = vi.spyOn(enabled, "stopPropagation");
  composer.dispatchEvent(enabled);

  expect(disabled.defaultPrevented).toBe(false);
  expect(disabledStop).not.toHaveBeenCalled();
  expect(enabled.defaultPrevented).toBe(true);
  expect(enabledStop).toHaveBeenCalledOnce();
  expect(bubbled).toHaveBeenCalledTimes(2);
  document.body.removeEventListener("keydown", bubbled);
});

test("leaves already prevented matching events untouched", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const composer = shortcutInput("textarea");
  const handler = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.startSession,
    available: () => true,
    handler,
    target: () => composer,
  });
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key: "Enter",
  });
  event.preventDefault();
  composer.dispatchEvent(event);

  expect(handler).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(true);
});

test("prioritizes the most recently activated context, not registration order", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  let directoryOpen = false;
  let helpOpen = false;
  const directoryClose = vi.fn();
  const helpClose = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.closeShortcutHelp,
    available: () => helpOpen,
    handler: helpClose,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.closeDirectoryPicker,
    available: () => directoryOpen,
    handler: directoryClose,
  });
  directoryOpen = true;
  helpOpen = true;

  shortcutKeyEvent(document.body, "Escape");

  expect(helpClose).toHaveBeenCalledOnce();
  expect(directoryClose).not.toHaveBeenCalled();
});

test("gives the top modal context priority and removes its listener on dispose", () => {
  registry = new KeyboardShortcutRegistry({
    eventTarget: document,
    platform: "other",
  });
  const directoryClose = vi.fn();
  const helpClose = vi.fn();
  registry.register({
    action: SHORTCUT_ACTIONS.closeDirectoryPicker,
    available: () => true,
    handler: directoryClose,
  });
  registry.register({
    action: SHORTCUT_ACTIONS.closeShortcutHelp,
    available: () => true,
    handler: helpClose,
  });

  expect(registry.available().map(({ action }) => action)).toEqual([
    SHORTCUT_ACTIONS.closeShortcutHelp,
  ]);
  const escape = shortcutKeyEvent(document.body, "Escape");

  expect(helpClose).toHaveBeenCalledOnce();
  expect(directoryClose).not.toHaveBeenCalled();
  expect(escape.defaultPrevented).toBe(true);

  registry.dispose();
  shortcutKeyEvent(document.body, "Escape");
  expect(helpClose).toHaveBeenCalledOnce();
});
