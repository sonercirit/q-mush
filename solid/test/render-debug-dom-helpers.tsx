import { type JSX } from "solid-js";
import { afterEach, expect, vi } from "vitest";
import {
  RenderDebugInstrumentation,
  RenderDebugToggle,
} from "../render-debug.tsx";
import { installFrames } from "./render-debug-test-helpers.ts";

const cleanups: (() => void)[] = [];

interface MockObserver {
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
  readonly records: (records: readonly MutationRecord[]) => void;
  readonly takeRecords: ReturnType<typeof vi.fn>;
}

interface DebugHarness {
  readonly debug: RenderDebugInstrumentation;
  readonly frames: ReturnType<typeof installFrames>;
  readonly observer: MockObserver;
}

interface DetachedHarness extends DebugHarness {
  readonly root: HTMLDivElement;
}

export function registerCleanup(cleanup: () => void): void {
  cleanups.push(cleanup);
}

export function expectDetached(harness: DebugHarness): void {
  expect(harness.observer.observe).not.toHaveBeenCalled();
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  expect(harness.frames.pending()).toBe(0);
}

export function verifyHarness(
  harness: DebugHarness,
  options: {
    readonly attached: boolean;
    readonly enabled: boolean;
  },
): void {
  expect(harness.debug.enabled).toBe(options.enabled);
  if (options.attached) {
    expect(harness.observer.observe).toHaveBeenCalledOnce();
  } else {
    expectDetached(harness);
  }
}

export function enabledHarness(root: Element): DebugHarness {
  const harness = createHarness(root);
  harness.debug.toggle();
  harness.frames.flush();
  return harness;
}

export function createHarness(root?: Element): DebugHarness {
  const observer = installMockObserver();
  const frames = installFrames();
  const debug = instrumentation(root);
  return { debug, frames, observer };
}

export function detachedHarness(): DetachedHarness {
  const root = document.createElement("div");
  const harness = createHarness();
  return { ...harness, root };
}

export function emitMutation(
  harness: DebugHarness,
  record: MutationRecord,
  timestamp: number,
): void {
  harness.observer.records([record]);
  harness.frames.flush(timestamp);
}

export function appRoot(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "test-app";
  document.body.append(root);
  return root;
}

export function instrumentation(root?: Element): RenderDebugInstrumentation {
  const debug = new RenderDebugInstrumentation();
  if (root !== undefined) {
    debug.attach(root);
  }
  cleanups.push(() => {
    debug.detach();
  });
  return debug;
}

export function element(selector: string): HTMLElement {
  const match = document.querySelector(selector);
  if (!(match instanceof HTMLElement)) {
    throw new Error(`The test element ${selector} was not found`);
  }
  return match;
}

export function selectElement(selector: string): HTMLSelectElement {
  const match = document.querySelector(selector);
  if (!(match instanceof HTMLSelectElement)) {
    throw new Error(`The test select ${selector} was not found`);
  }
  return match;
}

export function highlights(): readonly HTMLElement[] {
  return [...document.querySelectorAll(".render-debug-highlight")].filter(
    (match): match is HTMLElement => match instanceof HTMLElement,
  );
}

export function highlight(label: string): HTMLElement | undefined {
  return highlights().find((match) => match.textContent.startsWith(label));
}

export function expectHighlight(label: string, kind: string): HTMLElement {
  const match = highlight(label);
  expect(match?.classList.contains(`render-debug-highlight--${kind}`)).toBe(
    true,
  );
  if (match === undefined) {
    throw new Error(`The debug highlight for ${label} was not rendered`);
  }
  return match;
}

export function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tagName: K,
  id: string,
): HTMLElementTagNameMap[K] {
  const child = document.createElement(tagName);
  child.id = id;
  parent.appendChild(child);
  return child;
}

function installMockObserver(): MockObserver {
  let callback: MutationCallback | undefined;
  const disconnect = vi.fn();
  const observe = vi.fn();
  const takeRecords = vi.fn<() => MutationRecord[]>(() => []);
  class MockMutationObserver implements MutationObserver {
    constructor(nextCallback: MutationCallback) {
      callback = nextCallback;
    }

    disconnect(): void {
      disconnect();
    }

    observe(target: Node, options?: MutationObserverInit): void {
      observe(target, options);
    }

    takeRecords(): MutationRecord[] {
      return takeRecords();
    }
  }
  Object.defineProperty(window, "MutationObserver", {
    configurable: true,
    value: MockMutationObserver,
    writable: true,
  });
  return {
    disconnect,
    observe,
    records: (records) => {
      if (callback === undefined) {
        throw new Error("The debug observer was not attached");
      }
      callback([...records], new MockMutationObserver(callback));
    },
    takeRecords,
  };
}

export function expectUiState(options: {
  readonly children: readonly Node[];
  readonly focused: Element;
  readonly root: HTMLElement;
  readonly scrollTop: number;
}): void {
  expect([...options.root.childNodes]).toEqual(options.children);
  expect(document.activeElement).toBe(options.focused);
  expect(options.root.scrollTop).toBe(options.scrollTop);
}

export function DebugControls(props: {
  readonly debug: RenderDebugInstrumentation;
}): JSX.Element {
  return (
    <>
      <input aria-label="Focus keeper" />
      <RenderDebugToggle instrumentation={props.debug} />
    </>
  );
}

export function DebugFilters(props: {
  readonly debug: RenderDebugInstrumentation;
}): JSX.Element {
  return <RenderDebugToggle instrumentation={props.debug} />;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
