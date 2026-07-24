/* cpd-ignore-start -- deterministic MutationObserver DOM harness */
import { render } from "solid-js/web";
import { expect, test, vi } from "vitest";
import {
  appendElement,
  appRoot,
  createHarness,
  DebugFilters,
  detachedHarness,
  element,
  emitMutation,
  enabledHarness,
  expectHighlight,
  highlight,
  highlights,
  instrumentation,
  registerCleanup,
  selectElement,
  verifyHarness,
} from "./render-debug-dom-helpers.tsx";
import {
  createMutationRecord,
  installFrames,
} from "./render-debug-test-helpers.ts";

test("filters highlights and reports bounded cumulative update counts", () => {
  const root = appRoot();
  const harness = createHarness(root);
  const dispose = render(() => <DebugFilters debug={harness.debug} />, root);
  registerCleanup(dispose);
  const first = appendElement(root, "p", "first");
  first.className = "tracked";
  const second = appendElement(root, "p", "second");
  const toggle = element("button");
  toggle.click();
  harness.frames.flush();
  const filter = selectElement("#render-debug-filter");
  const trackedOption = document.createElement("option");
  trackedOption.value = ".tracked";
  filter.append(trackedOption);
  filter.value = ".tracked";
  filter.dispatchEvent(
    new window.Event("input", { bubbles: true, composed: true }),
  );
  expect(filter.value).toBe(".tracked");
  expect(highlight("p#second")).toBeUndefined();
  for (let index = 0; index < 3; index += 1) {
    first.setAttribute("data-revision", String(index));
    harness.observer.records([
      createMutationRecord({
        attributeName: "data-revision",
        target: first,
        type: "attributes",
      }),
      createMutationRecord({
        attributeName: "data-revision",
        target: second,
        type: "attributes",
      }),
    ]);
    harness.frames.flush(index * 16);
  }
  expectHighlight("p#first", "attribute");
  expect(highlight("p#second")).toBeUndefined();
  const details = element(".render-debug-legend__details").textContent;
  expect(details).toContain("p#first");
  expect(details).toContain("4 mutations");
});
test("drains queued observer records before disabling", () => {
  const root = appRoot();
  const output = appendElement(root, "p", "queued");
  const harness = enabledHarness(root);
  const filter = selectElement("#render-debug-filter");
  const queued = createMutationRecord({
    attributeName: "aria-busy",
    target: output,
    type: "attributes",
  });
  harness.observer.takeRecords.mockReturnValueOnce([queued]);
  harness.debug.toggle();
  expect(harness.observer.takeRecords).toHaveBeenCalledOnce();
  expect(harness.observer.disconnect).toHaveBeenCalledOnce();
  expect(() => {
    filter.dispatchEvent(new Event("input"));
  }).not.toThrow();
  expect(harness.frames.pending()).toBe(0);
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  harness.observer.takeRecords.mockClear();
  harness.debug.toggle();
  expect(harness.observer.takeRecords).not.toHaveBeenCalled();
});
test("excludes its overlay from observation and does not recurse", () => {
  const host = appendElement(document.body, "main", "content");
  const harness = enabledHarness(document.body);
  harness.frames.request.mockClear();
  const overlay = element("#render-debug-overlay");
  const probe = appendElement(overlay, "span", "overlay-probe");
  harness.observer.records([
    createMutationRecord({
      addedNodes: [probe],
      target: overlay,
      type: "childList",
    }),
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
      createMutationRecord({ target: text, type: "characterData" }),
    ),
    ...Array.from({ length: 2 }, () =>
      createMutationRecord({
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
test("skips offscreen updates until an element enters the viewport", () => {
  const root = appRoot();
  const output = appendElement(root, "p", "offscreen");
  let top = window.innerHeight + 100;
  vi.spyOn(output, "getBoundingClientRect").mockImplementation(() =>
    DOMRect.fromRect({ height: 20, width: 100, x: 0, y: top }),
  );
  const harness = enabledHarness(root);
  expect(highlight("p#offscreen")).toBeUndefined();
  top = 10;
  output.setAttribute("aria-busy", "true");
  emitMutation(
    harness,
    createMutationRecord({
      attributeName: "aria-busy",
      target: output,
      type: "attributes",
    }),
    16,
  );
  expectHighlight("p#offscreen", "attribute");
});
test("reattaches to a replacement root without retaining the old root", () => {
  const firstRoot = appRoot();
  firstRoot.id = "first-root";
  const harness = enabledHarness(firstRoot);
  const secondRoot = document.createElement("div");
  secondRoot.id = "second-root";
  firstRoot.replaceWith(secondRoot);
  harness.debug.attach(secondRoot);
  harness.frames.flush();
  expect(harness.observer.disconnect).toHaveBeenCalledOnce();
  expect(harness.observer.observe).toHaveBeenCalledTimes(2);
  expect(harness.observer.observe).toHaveBeenLastCalledWith(
    document.body,
    expect.any(Object),
  );
  expectHighlight("div#second-root", "initial");
  harness.debug.toggle();
  secondRoot.setAttribute("data-stale", "true");
  harness.observer.records([
    createMutationRecord({
      attributeName: "data-stale",
      target: secondRoot,
      type: "attributes",
    }),
  ]);
  expect(harness.frames.pending()).toBe(0);
});
test("starts safely when MutationObserver is unavailable", () => {
  const root = appRoot();
  const frames = installFrames();
  const debug = instrumentation(root);
  Object.defineProperty(window, "MutationObserver", {
    configurable: true,
    value: undefined,
  });
  expect(() => {
    debug.toggle();
  }).not.toThrow();
  expect(debug.enabled).toBe(true);
  expect(document.querySelector("#render-debug-overlay")).toBeNull();
  expect(frames.pending()).toBe(0);
});
test("bounds initial and streaming highlight work", () => {
  const bounds = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const root = appRoot();
  for (let index = 0; index < 1_200; index += 1) {
    const parent = appendElement(root, "div", `static-${String(index)}`);
    appendElement(parent, "span", `child-${String(index)}`);
  }
  const harness = enabledHarness(root);
  expect(highlights().length).toBeLessThanOrEqual(100);
  for (const highlight of highlights()) {
    highlight.dispatchEvent(new Event("animationend"));
  }
  const mutations: MutationRecord[] = [];
  for (let index = 0; index < 500; index += 1) {
    const element = appendElement(root, "div", `stream-${String(index)}`);
    mutations.push(
      createMutationRecord({
        attributeName: "aria-busy",
        target: element,
        type: "attributes",
      }),
    );
  }
  harness.observer.records(mutations);
  harness.frames.flush(16);
  expect(highlights().length).toBeLessThanOrEqual(100);
  expect(bounds.mock.calls.length).toBeLessThanOrEqual(600);
});
/* cpd-ignore-end -- deterministic MutationObserver DOM harness */
