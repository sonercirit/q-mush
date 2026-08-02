import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
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

function nodeList(...nodes: Node[]): NodeList {
  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  return fragment.childNodes;
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
  const detail = {
    ...runningSessionDetail(
      Array.from({ length: 80 }, (_, index) => toolResult(index)),
    ),
    tools: [],
  };
  const { container } = mountTestSessionDetail(detail, disposals);
  const root = container.querySelector(".session-detail-view");
  if (!(root instanceof HTMLElement))
    throw new TypeError("Missing detail root");
  expect(container.querySelectorAll("[data-line-wrap]")).toHaveLength(80);
  const callback = callbacks[0];
  if (callback === undefined) throw new TypeError("Missing mutation observer");
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
      new MutationObserverStub(() => undefined),
    );
  }

  expect(query).not.toHaveBeenCalled();
});
