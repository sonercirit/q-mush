import { type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, test, vi } from "vitest";
import {
  RenderDebugInstrumentation,
  RenderDebugToggle,
} from "../render-debug.tsx";

const cleanups: (() => void)[] = [];

interface MockObserver {
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly observe: ReturnType<typeof vi.fn>;
  readonly records: (records: readonly MutationRecord[]) => void;
}

interface DebugHarness {
  readonly debug: RenderDebugInstrumentation;
  readonly frames: ReturnType<typeof installFrames>;
  readonly observer: MockObserver;
}

interface DetachedHarness extends DebugHarness {
  readonly root: HTMLDivElement;
}

function expectDetached(harness: DebugHarness): void {
  expect(harness.observer.observe).not.toHaveBeenCalled();
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  expect(harness.frames.pending()).toBe(0);
}

function verifyHarness(
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

function enabledHarness(root: Element): DebugHarness {
  const harness = createHarness(root);
  harness.debug.toggle();
  harness.frames.flush();
  return harness;
}

function createHarness(root?: Element): DebugHarness {
  const observer = installMockObserver();
  const frames = installFrames();
  const debug = instrumentation(root);
  return { debug, frames, observer };
}

function detachedHarness(): DetachedHarness {
  const root = document.createElement("div");
  const harness = createHarness();
  return { ...harness, root };
}

function emitMutation(
  harness: DebugHarness,
  record: MutationRecord,
  timestamp: number,
): void {
  harness.observer.records([record]);
  harness.frames.flush(timestamp);
}

function appRoot(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "test-app";
  document.body.append(root);
  return root;
}

function instrumentation(root?: Element): RenderDebugInstrumentation {
  const debug = new RenderDebugInstrumentation();
  if (root !== undefined) {
    debug.attach(root);
  }
  cleanups.push(() => {
    debug.detach();
  });
  return debug;
}

function element(selector: string): HTMLElement {
  const match = document.querySelector(selector);
  if (!(match instanceof HTMLElement)) {
    throw new Error(`The test element ${selector} was not found`);
  }
  return match;
}

function highlights(): readonly HTMLElement[] {
  return [...document.querySelectorAll(".render-debug-highlight")].filter(
    (match): match is HTMLElement => match instanceof HTMLElement,
  );
}

function highlight(label: string): HTMLElement | undefined {
  return highlights().find((match) => match.textContent.startsWith(label));
}

function expectHighlight(label: string, kind: string): HTMLElement {
  const match = highlight(label);
  expect(match?.classList.contains(`render-debug-highlight--${kind}`)).toBe(
    true,
  );
  if (match === undefined) {
    throw new Error(`The debug highlight for ${label} was not rendered`);
  }
  return match;
}

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tagName: K,
  id: string,
): HTMLElementTagNameMap[K] {
  const child = document.createElement(tagName);
  child.id = id;
  parent.appendChild(child);
  return child;
}

function mutationRecord(options: {
  readonly addedNodes?: readonly Node[];
  readonly attributeName?: string;
  readonly removedNodes?: readonly Node[];
  readonly target: Node;
  readonly type: MutationRecordType;
}): MutationRecord {
  return {
    addedNodes: nodeList(options.addedNodes ?? []),
    attributeName: options.attributeName ?? null,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes: nodeList(options.removedNodes ?? []),
    target: options.target,
    type: options.type,
  };
}

function nodeList(nodes: readonly Node[]): NodeList {
  return {
    entries: () => nodes.entries(),
    forEach: (callback) => {
      nodes.forEach((node, index) => {
        callback(node, index, nodeList(nodes));
      });
    },
    item: (index) => nodes[index] ?? null,
    keys: () => nodes.keys(),
    length: nodes.length,
    values: () => nodes.values(),
    [Symbol.iterator]: () => nodes[Symbol.iterator](),
  };
}

function installMockObserver(): MockObserver {
  let callback: MutationCallback | undefined;
  const disconnect = vi.fn();
  const observe = vi.fn();
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
      return [];
    }
  }
  window.MutationObserver = MockMutationObserver;
  return {
    disconnect,
    observe,
    records: (records) => {
      if (callback === undefined) {
        throw new Error("The debug observer was not attached");
      }
      callback([...records], new MockMutationObserver(callback));
    },
  };
}

function installFrames(): {
  readonly flush: (timestamp?: number) => void;
  readonly pending: () => number;
  readonly request: ReturnType<typeof vi.fn>;
} {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const request = vi
    .spyOn(window, "requestAnimationFrame")
    .mockImplementation((callback) => {
      nextFrame += 1;
      callbacks.set(nextFrame, callback);
      return nextFrame;
    });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    callbacks.delete(frame);
  });
  return {
    flush: (timestamp = 0) => {
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) {
        callback(timestamp);
      }
    },
    pending: () => callbacks.size,
    request,
  };
}

function expectUiState(options: {
  readonly children: readonly Node[];
  readonly focused: Element;
  readonly root: HTMLElement;
  readonly scrollTop: number;
}): void {
  expect([...options.root.childNodes]).toEqual(options.children);
  expect(document.activeElement).toBe(options.focused);
  expect(options.root.scrollTop).toBe(options.scrollTop);
}

function DebugControls(props: {
  readonly debug: RenderDebugInstrumentation;
}): JSX.Element {
  return (
    <>
      <input aria-label="Focus keeper" />
      <RenderDebugToggle instrumentation={props.debug} />
    </>
  );
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test("does no observer or overlay work while off and highlights every static element when enabled", () => {
  const root = appRoot();
  const section = appendElement(root, "section", "static-section");
  appendElement(section, "span", "static-child");
  const harness = createHarness(root);

  expectDetached(harness);

  harness.debug.toggle();
  harness.frames.flush();

  verifyHarness(harness, { attached: true, enabled: true });
  expectHighlight("div#test-app", "initial");
  expectHighlight("section#static-section", "initial");
  expectHighlight("span#static-child", "initial");
});

test("automatically highlights dynamically inserted elements and their descendants", () => {
  const root = appRoot();
  const harness = enabledHarness(root);

  const dynamic = document.createElement("article");
  dynamic.id = "dynamic";
  appendElement(dynamic, "strong", "dynamic-child");
  root.append(dynamic);
  emitMutation(
    harness,
    mutationRecord({ addedNodes: [dynamic], target: root, type: "childList" }),
    16,
  );

  expectHighlight("article#dynamic", "insert");
  expectHighlight("strong#dynamic-child", "insert");
});

test("highlights text changes on their nearest element", () => {
  const root = appRoot();
  const paragraph = appendElement(root, "p", "copy");
  const copy = document.createTextNode("Before");
  paragraph.append(copy);
  const harness = enabledHarness(root);

  copy.data = "After";
  emitMutation(
    harness,
    mutationRecord({ target: copy, type: "characterData" }),
    32,
  );

  expect(expectHighlight("p#copy", "text").textContent).toContain("text");
});

test("highlights attribute changes on the changed element", () => {
  const root = appRoot();
  const button = appendElement(root, "button", "save");
  const harness = enabledHarness(root);

  button.setAttribute("aria-pressed", "true");
  emitMutation(
    harness,
    mutationRecord({
      attributeName: "aria-pressed",
      target: button,
      type: "attributes",
    }),
    48,
  );

  expect(expectHighlight("button#save", "attribute").textContent).toContain(
    "aria-pressed",
  );
});

test("highlights the surviving parent when a child is removed", () => {
  const root = appRoot();
  const list = appendElement(root, "ul", "items");
  const item = appendElement(list, "li", "removed-item");
  const harness = enabledHarness(root);

  item.remove();
  emitMutation(
    harness,
    mutationRecord({ removedNodes: [item], target: list, type: "childList" }),
    64,
  );

  expectHighlight("ul#items", "remove");
  expect(highlight("li#removed-item")).toBeUndefined();
});

test("the toggle attaches and cleans up without changing app order, focus, or scroll", () => {
  const root = appRoot();
  const scrollTop = 37;
  root.scrollTop = scrollTop;
  const harness = createHarness(root);
  const dispose = render(() => <DebugControls debug={harness.debug} />, root);
  cleanups.push(() => {
    dispose();
  });
  const input = element("input");
  const toggle = element("button");
  const appChildren = [...root.childNodes];
  input.focus();

  toggle.click();
  harness.frames.flush();

  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expectUiState({ children: appChildren, focused: input, root, scrollTop });
  expectHighlight("button", "initial");

  toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(harness.observer.disconnect).toHaveBeenCalledOnce();
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  expectUiState({ children: appChildren, focused: input, root, scrollTop });

  input.setAttribute("aria-label", "Changed while disabled");
  expect(harness.frames.pending()).toBe(0);
});

test("excludes its overlay from observation and does not recurse", () => {
  const host = appendElement(document.body, "main", "content");
  const harness = enabledHarness(document.body);
  harness.frames.request.mockClear();
  const overlay = element("#render-debug-overlay");
  const probe = appendElement(overlay, "span", "overlay-probe");

  harness.observer.records([
    mutationRecord({ addedNodes: [probe], target: overlay, type: "childList" }),
  ]);

  expect(highlight("div#render-debug-overlay")).toBeUndefined();
  expect(highlight("span#overlay-probe")).toBeUndefined();
  expect(harness.frames.request).not.toHaveBeenCalled();
  expect(host.isConnected).toBe(true);
});

test("batches streaming mutations to one highlight per element and animation frame", () => {
  const root = appRoot();
  const output = appendElement(root, "p", "stream");
  const text = document.createTextNode("0");
  output.append(text);
  const harness = enabledHarness(root);
  harness.frames.request.mockClear();

  harness.observer.records([
    ...Array.from({ length: 3 }, () =>
      mutationRecord({ target: text, type: "characterData" }),
    ),
    ...Array.from({ length: 2 }, () =>
      mutationRecord({
        attributeName: "aria-busy",
        target: output,
        type: "attributes",
      }),
    ),
  ]);

  expect(harness.frames.pending()).toBe(1);
  expect(harness.frames.request).toHaveBeenCalledOnce();
  harness.frames.flush(80);

  const updated = expectHighlight("p#stream", "text");
  expect(
    highlights().filter((match) => match.textContent.startsWith("p#stream")),
  ).toHaveLength(1);
  expect(updated.classList.contains("render-debug-highlight--attribute")).toBe(
    true,
  );
  expect(updated.textContent).toContain("text ×3");
  expect(updated.textContent).toContain("attribute ×2");
});

test("attaches after the root mounts and instruments it when already enabled", () => {
  const harness = detachedHarness();
  harness.root.id = "late-root";
  harness.debug.toggle();

  harness.debug.attach(harness.root);

  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  document.body.append(harness.root);
  harness.debug.attach(harness.root);
  harness.frames.flush();
  expectHighlight("div#late-root", "initial");
  verifyHarness(harness, { attached: true, enabled: true });
});

test("stays inert when enabled without an attached app root", () => {
  const harness = detachedHarness();

  harness.debug.toggle();

  verifyHarness(harness, { attached: false, enabled: true });

  harness.debug.toggle();
  expect(harness.debug.enabled).toBe(false);
});
