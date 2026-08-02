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
  readonly target?: Node;
}): MutationRecord {
  return {
    addedNodes: options.addedNodes,
    attributeName: null,
    attributeNamespace: null,
    nextSibling: null,
    oldValue: null,
    previousSibling: null,
    removedNodes: options.removedNodes,
    target: options.target ?? document.createElement("div"),
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
  const target = current.parentElement;
  if (target === null) throw new TypeError("Missing replacement parent");
  current.replaceWith(replacement);
  return mutation({
    addedNodes,
    removedNodes: nodeList(current),
    target,
  });
}

interface StructuralPaneScenario extends MountedMutationDetail {
  readonly first: HTMLElement;
  readonly insertedWrapper: HTMLElement;
  readonly second: HTMLElement;
}

function structuralPaneScenario(): StructuralPaneScenario {
  const mounted = mountMutationDetail([toolResult(0), toolResult(1)]);
  const panes = [
    ...mounted.root.querySelectorAll<HTMLElement>("[data-line-wrap]"),
  ];
  const first = panes[0];
  const second = panes[1];
  if (first === undefined || second === undefined)
    throw new TypeError("Missing remembered panes");
  const insertedWrapper = first.parentElement?.cloneNode(true);
  if (!(insertedWrapper instanceof HTMLElement))
    throw new TypeError("Missing inserted pane");
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
  return { ...mounted, first, insertedWrapper, second };
}

function insertStructuralPane(
  scenario: StructuralPaneScenario,
): MutationRecord {
  const insertedNodes = nodeList(scenario.insertedWrapper);
  const insertionHost = document.createElement("div");
  insertionHost.append(scenario.insertedWrapper);
  scenario.root.prepend(insertionHost);
  return mutation({
    addedNodes: insertedNodes,
    removedNodes: nodeList(),
    target: scenario.root,
  });
}

function replaceRememberedPanes(
  scenario: StructuralPaneScenario,
): MutationRecord[] {
  const firstReplacement = nestedPaneReplacement(scenario.first);
  const secondReplacement = nestedPaneReplacement(scenario.second);
  defineElementSize(firstReplacement.pane, 100, 1_000);
  defineElementSize(secondReplacement.pane, 100, 1_000);
  return [
    replacePaneWrapper(
      scenario.first.parentElement ?? scenario.first,
      firstReplacement.wrapper,
    ),
    replacePaneWrapper(
      scenario.second.parentElement ?? scenario.second,
      secondReplacement.wrapper,
    ),
  ];
}

function expectStructuralPaneStates(root: HTMLElement): void {
  const panes = [...root.querySelectorAll<HTMLElement>("[data-line-wrap]")];
  expect(
    panes.map((pane) => [pane.scrollTop, pane.dataset["lineWrap"] === "true"]),
  ).toEqual([
    [0, true],
    [20, false],
    [70, true],
  ]);
  expect(
    panes.map((pane) =>
      pane.parentElement
        ?.querySelector("[data-subscroll-wrap-toggle]")
        ?.getAttribute("aria-pressed"),
    ),
  ).toEqual(["true", "false", "true"]);
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
  const scenario = structuralPaneScenario();
  scenario.callback(
    [insertStructuralPane(scenario)],
    scenario.harness.observer(),
  );
  scenario.callback(
    replaceRememberedPanes(scenario),
    scenario.harness.observer(),
  );

  expectStructuralPaneStates(scenario.root);
});

test("restores replacements after insertion in the same mutation batch", () => {
  const scenario = structuralPaneScenario();
  const mutations = [
    insertStructuralPane(scenario),
    ...replaceRememberedPanes(scenario),
  ];

  scenario.callback(mutations, scenario.harness.observer());

  expectStructuralPaneStates(scenario.root);
});
