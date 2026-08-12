import { createSignal, For, Show, type JSX } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentSessionMessage } from "../../shared/session-model.ts";
import { createNestedScrollRef } from "../nested-scroll.ts";
import { mountTestView } from "./dom-test-helpers.ts";
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

function mutationCallback(harness: MutationObserverHarness): MutationCallback {
  const callback = harness.callbacks[0];
  if (callback === undefined) throw new TypeError("Missing mutation observer");
  return callback;
}

interface MountedMutationDetail {
  readonly callback: MutationCallback;
  readonly container: HTMLDivElement;
  readonly harness: MutationObserverHarness;
  readonly root: HTMLElement;
}

function mountedMutationDetail(
  container: HTMLDivElement,
  harness: MutationObserverHarness,
  selector: string,
): MountedMutationDetail {
  const root = container.querySelector(selector);
  if (!(root instanceof HTMLElement))
    throw new TypeError(`Missing mutation root: ${selector}`);
  return {
    callback: mutationCallback(harness),
    container,
    harness,
    root,
  };
}

function mountMutationDetail(
  messages: readonly AgentSessionMessage[],
): MountedMutationDetail {
  const harness = installMutationObserverHarness();
  const detail = { ...runningSessionDetail(messages), tools: [] };
  const { container } = mountTestSessionDetail(detail, disposals);
  return mountedMutationDetail(container, harness, ".session-detail-view");
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

function rememberPane(
  pane: HTMLElement,
  top: number,
  toggle?: HTMLButtonElement,
): void {
  defineElementSize(pane, 100, 1_000);
  toggle?.click();
  pane.scrollTop = top;
  pane.dispatchEvent(new Event("scroll", { bubbles: true }));
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
  rememberPane(first, 20, firstToggle);
  rememberPane(second, 70);
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

function paneScope(pane: HTMLElement): HTMLElement {
  const scope = pane.closest(".contents");
  if (!(scope instanceof HTMLElement))
    throw new TypeError("Missing pane scope");
  return scope;
}

function mutationTestPane(props: {
  readonly id: string;
  readonly label: string;
}): JSX.Element {
  const nestedScrollRef = createNestedScrollRef(() => props.id);
  return (
    <section data-mutation-pane-scope={props.label} ref={nestedScrollRef}>
      <div
        class="overflow-auto"
        data-mutation-pane={props.label}
        data-line-wrap="true"
      />
    </section>
  );
}

function MutationDetailFixture(props: {
  readonly extra: boolean;
}): JSX.Element {
  const nestedScrollRef = createNestedScrollRef(
    () => "mutation-remount-detail",
    true,
  );
  return (
    <div data-mutation-detail="true" ref={nestedScrollRef}>
      <Show when={props.extra}>
        {mutationTestPane({ id: "mutation-pane-extra", label: "extra" })}
      </Show>
      {mutationTestPane({ id: "mutation-pane-first", label: "first" })}
      {mutationTestPane({ id: "mutation-pane-second", label: "second" })}
    </div>
  );
}

function queryMutationPane(container: ParentNode, label: string): HTMLElement {
  const pane = container.querySelector(`[data-mutation-pane='${label}']`);
  if (!(pane instanceof HTMLElement))
    throw new TypeError(`Missing ${label} mutation pane`);
  return pane;
}

function WithinScopeFixture(props: {
  readonly labels: readonly string[];
}): JSX.Element {
  const nestedScrollRef = createNestedScrollRef(
    () => "within-scope-mutations",
    true,
  );
  return (
    <section data-within-scope-fixture="true" ref={nestedScrollRef}>
      <For each={props.labels}>
        {(label) => (
          <div
            class="overflow-auto"
            data-line-wrap="true"
            data-mutation-pane={label}
          />
        )}
      </For>
    </section>
  );
}

function mountWithinScopeFixture(
  labels: readonly string[],
): MountedMutationDetail {
  const harness = installMutationObserverHarness();
  const container = mountTestView(
    () => <WithinScopeFixture labels={labels} />,
    disposals,
  );
  return mountedMutationDetail(
    container,
    harness,
    "[data-within-scope-fixture]",
  );
}

function rememberWithinScopePanes(
  panes: readonly (readonly [label: string, top: number])[],
): MountedMutationDetail {
  const mounted = mountWithinScopeFixture(panes.map(([label]) => label));
  for (const [label, top] of panes) {
    rememberPane(queryMutationPane(mounted.container, label), top);
  }
  return mounted;
}

function withinScopePaneStates(
  root: HTMLElement,
): readonly (readonly [string | undefined, number])[] {
  return [...root.querySelectorAll<HTMLElement>("[data-mutation-pane]")].map(
    (pane) => [pane.dataset["mutationPane"], pane.scrollTop],
  );
}

function notifyWithinScopeMutation(
  mounted: MountedMutationDetail,
  addedNodes: NodeList,
  removedNodes: NodeList,
): void {
  mounted.callback(
    [mutation({ addedNodes, removedNodes, target: mounted.root })],
    mounted.harness.observer(),
  );
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

function ReKeyedRowFixture(props: {
  readonly rowKey: string;
  readonly showSecond: boolean;
}): JSX.Element {
  // The lazy id re-keys the mounted pane in place instead of remounting.
  return (
    <div>
      {mutationTestPane({
        get id() {
          return props.rowKey;
        },
        label: "retained",
      })}
      <Show when={props.showSecond}>
        {mutationTestPane({ id: "after:user-1:thinking:0", label: "claimant" })}
      </Show>
    </div>
  );
}

test("a row claiming a migrated key does not inherit the old row's state", async () => {
  const [rowKey, setRowKey] = createSignal("after:user-1:thinking:0");
  const [showSecond, setShowSecond] = createSignal(false);
  const container = mountTestView(
    () => <ReKeyedRowFixture rowKey={rowKey()} showSecond={showSecond()} />,
    disposals,
  );
  const retained = queryMutationPane(container, "retained");
  rememberPane(retained, 55);

  // The retained row re-keys (its transcript prefix grew), then a new row
  // claims the released key: the claimant must start clean, not restore
  // the offset remembered under the old key. Restores run on microtasks.
  setRowKey("after:tool-1:thinking:0");
  setShowSecond(true);
  const claimant = queryMutationPane(container, "claimant");
  defineElementSize(claimant, 100, 1_000);
  const scopeKey = (label: string): string | null =>
    container
      .querySelector(`[data-mutation-pane-scope='${label}']`)
      ?.getAttribute("data-nested-scroll-key") ?? null;
  expect(scopeKey("retained")).toBe("after:tool-1:thinking:0");
  expect(scopeKey("claimant")).toBe("after:user-1:thinking:0");
  await Promise.resolve();
  await Promise.resolve();
  expect(claimant.scrollTop).toBe(0);
  expect(retained.scrollTop).toBe(55);
});

test("keeps pane state with elements reordered within one scope", () => {
  const mounted = rememberWithinScopePanes([
    ["first", 20],
    ["second", 70],
  ]);
  const second = queryMutationPane(mounted.container, "second");
  const movedNodes = nodeList(second);
  mounted.root.prepend(second);

  notifyWithinScopeMutation(mounted, movedNodes, movedNodes);

  expect(withinScopePaneStates(mounted.root)).toEqual([
    ["second", 70],
    ["first", 20],
  ]);
});

test("drops a removed middle pane without shifting its state", () => {
  const mounted = rememberWithinScopePanes([
    ["first", 20],
    ["middle", 40],
    ["last", 70],
  ]);
  const middle = queryMutationPane(mounted.container, "middle");

  notifyWithinScopeMutation(mounted, nodeList(), nodeList(middle));

  expect(withinScopePaneStates(mounted.root)).toEqual([
    ["first", 20],
    ["last", 70],
  ]);
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

function scenarioPaneScope(scenario: StructuralPaneScenario): HTMLElement {
  return paneScope(scenario.first);
}

function splitMutation(
  removedNodes: NodeList,
  removalTarget: Node,
  addedNodes: NodeList,
  additionTarget: Node,
): MutationRecord[] {
  return [
    mutation({ addedNodes: nodeList(), removedNodes, target: removalTarget }),
    mutation({ addedNodes, removedNodes: nodeList(), target: additionTarget }),
  ];
}

function currentPaneWrapper(scenario: StructuralPaneScenario): HTMLElement {
  const wrapper = scenario.first.parentElement;
  if (wrapper === null) throw new TypeError("Missing pane wrapper");
  return wrapper;
}

test("restores a split replacement across different mutation targets", () => {
  const scenario = structuralPaneScenario();
  const scope = scenarioPaneScope(scenario);
  const currentWrapper = currentPaneWrapper(scenario);
  const removalTarget = currentWrapper.parentElement;
  if (removalTarget === null)
    throw new TypeError("Missing split replacement host");
  const replacement = nestedPaneReplacement(scenario.first);
  defineElementSize(replacement.pane, 100, 1_000);
  const additionTarget = document.createElement("div");
  scope.append(additionTarget);
  const removedNodes = nodeList(currentWrapper);
  const addedNodes = nodeList(replacement.wrapper);
  additionTarget.append(replacement.wrapper);

  scenario.callback(
    splitMutation(removedNodes, removalTarget, addedNodes, additionTarget),
    scenario.harness.observer(),
  );

  expect(replacement.pane.scrollTop).toBe(20);
  expect(replacement.pane.dataset["lineWrap"]).toBe("false");
});

test("does not transfer removed state to an unrelated same-target addition", () => {
  const scenario = structuralPaneScenario();
  const target = scenarioPaneScope(scenario).parentElement;
  if (target === null) throw new TypeError("Missing shared mutation target");
  const scope = scenarioPaneScope(scenario);
  const unrelated = scope.cloneNode(true);
  if (!(unrelated instanceof HTMLElement))
    throw new TypeError("Missing unrelated pane scope");
  unrelated.dataset["nestedScrollKey"] = "unrelated-pane";
  unrelated.dataset["renderBoundary"] = "message:unrelated-pane";
  const unrelatedPane =
    unrelated.querySelector<HTMLElement>("[data-line-wrap]");
  if (unrelatedPane === null) throw new TypeError("Missing unrelated pane");
  defineElementSize(unrelatedPane, 100, 1_000);
  const removedNodes = nodeList(scope);
  const addedNodes = nodeList(unrelated);
  target.append(unrelated);

  scenario.callback(
    splitMutation(removedNodes, target, addedNodes, target),
    scenario.harness.observer(),
  );

  expect(unrelatedPane.scrollTop).toBe(0);
});

interface MountedRemountFixture {
  readonly container: HTMLDivElement;
  readonly setExtra: (value: boolean) => void;
  readonly setVersion: (value: number) => void;
}

function mountRemountFixture(): MountedRemountFixture {
  const [extra, setExtra] = createSignal(false);
  const [version, setVersion] = createSignal(0);
  const container = mountTestView(
    () => (
      <Show
        when={version()}
        keyed
        fallback={<MutationDetailFixture extra={extra()} />}
      >
        <MutationDetailFixture extra={extra()} />
      </Show>
    ),
    disposals,
  );
  return { container, setExtra, setVersion };
}

test("structural updates and same-key remounts share pane state", async () => {
  const harness = installMutationObserverHarness();
  const { container, setExtra, setVersion } = mountRemountFixture();
  const first = queryMutationPane(container, "first");
  const second = queryMutationPane(container, "second");
  rememberPane(first, 20);
  rememberPane(second, 70);

  setExtra(true);
  const root = container.querySelector("[data-mutation-detail]");
  const extraScope = container.querySelector(
    "[data-mutation-pane-scope='extra']",
  );
  if (!(root instanceof HTMLElement) || !(extraScope instanceof HTMLElement))
    throw new TypeError("Missing structural pane insertion");
  const addedNodes = nodeList(extraScope);
  root.prepend(extraScope);
  mutationCallback(harness)(
    [mutation({ addedNodes, removedNodes: nodeList(), target: root })],
    harness.observer(),
  );
  setVersion(1);
  await Promise.resolve();

  const restored = ["extra", "first", "second"].map((label) => {
    const pane = queryMutationPane(container, label);
    defineElementSize(pane, 100, 1_000);
    return pane.scrollTop;
  });
  expect(restored).toEqual([0, 20, 70]);
});
