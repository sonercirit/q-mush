import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { defineElementSize } from "./element-size-test-helpers.ts";
import {
  mountTestSessionDetail,
  transcriptTestMessage,
} from "./session-dom-test-helpers.tsx";
import { runningSessionDetail } from "./transcript-ordering-fixtures.ts";

const disposals: (() => void)[] = [];

function toolResult(index: number): AgentSessionMessage {
  return {
    ...transcriptTestMessage(
      `historical-tool-${String(index)}`,
      `stdout:\nhistorical output ${String(index)}\nExit code: 0`,
      "tool",
      index + 1,
    ),
    toolCallId: `historical-call-${String(index)}`,
    toolName: "bash",
  };
}

function nodeList(...nodes: HTMLElement[]): NodeList {
  const container = document.createElement("div");
  container.append(...nodes);
  return container.querySelectorAll(":scope > *");
}

interface MutationObserverHarness {
  readonly callbacks: MutationCallback[];
  readonly observer: () => MutationObserver;
}

function installMutationObserverHarness(): MutationObserverHarness {
  const callbacks: MutationCallback[] = [];
  class MutationObserverStub implements MutationObserver {
    constructor(callback: MutationCallback) {
      callbacks.push(callback);
    }
    disconnect = vi.fn<MutationObserver["disconnect"]>();
    observe = vi.fn<MutationObserver["observe"]>();
    takeRecords = vi.fn<MutationObserver["takeRecords"]>(() => []);
  }
  vi.stubGlobal("MutationObserver", MutationObserverStub);
  return {
    callbacks,
    observer: () => new MutationObserverStub(() => undefined),
  };
}

interface MountedMutationDetail {
  readonly callback: MutationCallback;
  readonly container: HTMLDivElement;
  readonly harness: MutationObserverHarness;
  readonly root: HTMLElement;
}

function mountMutationDetail(
  messages: readonly AgentSessionMessage[],
): MountedMutationDetail {
  const harness = installMutationObserverHarness();
  const detail = { ...runningSessionDetail(messages), tools: [] };
  const { container } = mountTestSessionDetail(detail, disposals);
  const root = container.querySelector(".session-detail-view");
  if (!(root instanceof HTMLElement))
    throw new TypeError("Missing detail root");
  const callback = harness.callbacks[0];
  if (callback === undefined) throw new TypeError("Missing mutation observer");
  return { callback, container, harness, root };
}

function mutation(options: {
  readonly addedNodes: NodeList;
  readonly removedNodes: NodeList;
}): MutationRecord {
  return {
    addedNodes: options.addedNodes,
    attributeName: null,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes: options.removedNodes,
    target: document.createElement("div"),
    type: "childList",
  };
}

function nestedPaneReplacement(pane: HTMLElement): {
  readonly pane: HTMLElement;
  readonly wrapper: HTMLElement;
} {
  const currentWrapper = pane.parentElement;
  if (currentWrapper === null) throw new TypeError("Missing pane wrapper");
  const wrapper = currentWrapper.cloneNode(true);
  if (!(wrapper instanceof HTMLElement))
    throw new TypeError("Missing replacement wrapper");
  const replacement = wrapper.querySelector<HTMLElement>("[data-line-wrap]");
  if (replacement === null) throw new TypeError("Missing replacement pane");
  wrapper.addEventListener("subscroll-wrap-restore", (event) => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== "boolean")
      return;
    replacement.dataset["lineWrap"] = String(event.detail);
    const toggle = wrapper.querySelector<HTMLButtonElement>(
      "[data-subscroll-wrap-toggle]",
    );
    toggle?.setAttribute("aria-pressed", String(event.detail));
  });
  return { pane: replacement, wrapper };
}

function replacePaneWrapper(
  current: HTMLElement,
  replacement: HTMLElement,
): MutationRecord {
  const addedNodes = nodeList(replacement);
  current.replaceWith(replacement);
  return mutation({ addedNodes, removedNodes: nodeList(current) });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (;;) {
    const dispose = disposals.pop();
    if (dispose === undefined) return;
    dispose();
  }
});

test("unrelated transcript mutations do not rescan historical panes", () => {
  const messages = Array.from({ length: 80 }, (_, index) => toolResult(index));
  const { callback, container, harness, root } = mountMutationDetail(messages);
  expect(container.querySelectorAll("[data-line-wrap]")).toHaveLength(80);
  const pane = root.querySelector("[data-line-wrap]");
  if (!(pane instanceof HTMLElement)) throw new TypeError("Missing pane");
  pane.dispatchEvent(new Event("scroll", { bubbles: true }));
  const query = vi.spyOn(root, "querySelectorAll");

  for (let delta = 0; delta < 30; delta += 1) {
    callback(
      [
        mutation({
          addedNodes: nodeList(document.createElement("span")),
          removedNodes: nodeList(document.createElement("span")),
        }),
      ],
      harness.observer(),
    );
  }

  expect(query).not.toHaveBeenCalled();
});

test("structural pane insertion keeps later replacements correctly indexed", () => {
  const { callback, harness, root } = mountMutationDetail([
    toolResult(0),
    toolResult(1),
  ]);
  const panes = [...root.querySelectorAll<HTMLElement>("[data-line-wrap]")];
  const first = panes[0];
  const second = panes[1];
  if (first === undefined || second === undefined)
    throw new TypeError("Missing remembered panes");
  defineElementSize(first, 100, 1_000);
  defineElementSize(second, 100, 1_000);
  const firstToggle = first.parentElement?.querySelector<HTMLButtonElement>(
    "[data-subscroll-wrap-toggle]",
  );
  if (firstToggle === undefined || firstToggle === null)
    throw new TypeError("Missing wrap toggle");
  firstToggle.click();
  first.scrollTop = 20;
  first.dispatchEvent(new Event("scroll", { bubbles: true }));
  second.scrollTop = 70;
  second.dispatchEvent(new Event("scroll", { bubbles: true }));

  const insertedWrapper = first.parentElement?.cloneNode(true);
  if (!(insertedWrapper instanceof HTMLElement))
    throw new TypeError("Missing inserted pane");
  const insertedNodes = nodeList(insertedWrapper);
  const insertionHost = document.createElement("div");
  insertionHost.append(insertedWrapper);
  root.prepend(insertionHost);
  callback(
    [mutation({ addedNodes: insertedNodes, removedNodes: nodeList() })],
    harness.observer(),
  );

  const firstReplacement = nestedPaneReplacement(first);
  const secondReplacement = nestedPaneReplacement(second);
  defineElementSize(firstReplacement.pane, 100, 1_000);
  defineElementSize(secondReplacement.pane, 100, 1_000);
  callback(
    [
      replacePaneWrapper(
        first.parentElement ?? first,
        firstReplacement.wrapper,
      ),
      replacePaneWrapper(
        second.parentElement ?? second,
        secondReplacement.wrapper,
      ),
    ],
    harness.observer(),
  );

  expect(firstReplacement.pane.scrollTop).toBe(20);
  expect(firstReplacement.pane.dataset["lineWrap"]).toBe("false");
  expect(
    firstReplacement.wrapper
      .querySelector("[data-subscroll-wrap-toggle]")
      ?.getAttribute("aria-pressed"),
  ).toBe("false");
  expect(secondReplacement.pane.scrollTop).toBe(70);
  expect(secondReplacement.pane.dataset["lineWrap"]).toBe("true");
  expect(
    secondReplacement.wrapper
      .querySelector("[data-subscroll-wrap-toggle]")
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});
