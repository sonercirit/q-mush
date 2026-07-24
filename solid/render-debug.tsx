import { createSignal, type Accessor, type JSX, type Setter } from "solid-js";
import {
  createMutationSummary,
  createOverlay,
  elementLabel,
  MAXIMUM_DETAIL_ROWS,
  MAXIMUM_HIGHLIGHTS,
  MAXIMUM_SUMMARIES,
  MUTATION_KINDS,
  mutationDescription,
  mutationObserverFor,
  nearestElement,
  observeMutations,
  SENSITIVE_ATTRIBUTES,
  type MutationSummary,
  type RenderDebugMutationKind,
} from "./render-debug-support.ts";

export class RenderDebugInstrumentation {
  readonly #enabled: Accessor<boolean>;
  readonly #highlights = new Map<Element, HTMLDivElement>();
  readonly #summaries = new Map<Element, MutationSummary>();
  readonly #pending = new Map<Element, MutationSummary>();
  readonly #filterChanged = (): void => {
    if (this.#filterControl !== undefined) {
      this.#setFilter(this.#filterControl.value);
    }
  };
  readonly #setEnabled: Setter<boolean>;
  #animationFrame: number | undefined;
  #browserWindow: Window | undefined;
  #details: HTMLDivElement | undefined;
  #filter = "";
  #filterControl: HTMLSelectElement | undefined;
  #highlightLayer: HTMLDivElement | undefined;
  #observer: MutationObserver | undefined;
  #overlay: HTMLDivElement | undefined;
  #root: Element | undefined;
  constructor() {
    const [enabled, setEnabled] = createSignal(false);
    this.#enabled = enabled;
    this.#setEnabled = setEnabled;
  }
  get enabled(): boolean {
    return this.#enabled();
  }
  get enabledView(): Accessor<boolean> {
    return this.#enabled;
  }
  attach(root: Element): void {
    if (this.#root === root) {
      if (this.enabled) {
        this.#start();
      }
      return;
    }
    this.#stop();
    this.#root = root;
    if (this.enabled) {
      this.#start();
    }
  }
  detach(): void {
    this.#stop();
    this.#root = undefined;
  }
  toggle(): void {
    const enabled = !this.enabled;
    this.#setEnabled(enabled);
    if (enabled) {
      this.#start();
    } else {
      this.#stop();
    }
  }
  readonly #viewportChanged = (): void => {
    this.#scheduleFrame();
  };
  #setFilter(selector: string): void {
    this.#filter = selector;
    this.#pending.clear();
    for (const [element, highlight] of this.#highlights) {
      highlight.remove();
      this.#highlights.delete(element);
    }
    this.#renderDetails();
  }
  #matchesFilter(element: Element): boolean {
    if (this.#filter.length === 0) return true;
    try {
      return (
        element.matches(this.#filter) || element.closest(this.#filter) !== null
      );
    } catch {
      return false;
    }
  }
  #start(): void {
    const root = this.#root;
    if (
      root === undefined ||
      this.#observer !== undefined ||
      !root.isConnected
    ) {
      return;
    }
    const browserWindow = root.ownerDocument.defaultView;
    if (browserWindow === null) {
      return;
    }
    const Observer = mutationObserverFor(browserWindow);
    const body = root.ownerDocument.body;
    if (Observer === undefined) {
      return;
    }
    const overlay = createOverlay(root.ownerDocument);
    this.#details = overlay.details;
    this.#filter = overlay.filter.value;
    this.#filterControl = overlay.filter;
    this.#highlightLayer = overlay.highlights;
    this.#overlay = overlay.root;
    overlay.filter.addEventListener("input", this.#filterChanged);
    body.append(overlay.root);
    const observer = new Observer((mutations) => {
      this.#recordMutations(mutations);
    });
    observeMutations(observer, body);
    root.ownerDocument.addEventListener("scroll", this.#viewportChanged, true);
    browserWindow.addEventListener("resize", this.#viewportChanged);
    this.#browserWindow = browserWindow;
    this.#observer = observer;
    this.#record(root, "initial");
    const initialElements = body.querySelectorAll("*");
    for (let index = 0; index < initialElements.length; index += 1) {
      const element = initialElements.item(index);
      if (element !== root && this.#includes(element)) {
        this.#record(element, "initial");
      }
    }
  }
  #stop(): void {
    const records = this.#observer?.takeRecords() ?? [];
    if (records.length > 0) {
      this.#recordMutations(records);
    }
    this.#observer?.disconnect();
    this.#root?.ownerDocument.removeEventListener(
      "scroll",
      this.#viewportChanged,
      true,
    );
    this.#browserWindow?.removeEventListener("resize", this.#viewportChanged);
    this.#filterControl?.removeEventListener("input", this.#filterChanged);
    if (
      this.#animationFrame !== undefined &&
      this.#browserWindow !== undefined
    ) {
      this.#browserWindow.cancelAnimationFrame(this.#animationFrame);
    }
    this.#overlay?.remove();
    this.#highlights.clear();
    this.#summaries.clear();
    this.#pending.clear();
    this.#animationFrame = undefined;
    this.#browserWindow = undefined;
    this.#details = undefined;
    this.#filter = "";
    this.#filterControl = undefined;
    this.#highlightLayer = undefined;
    this.#observer = undefined;
    this.#overlay = undefined;
  }
  #recordMutations(mutations: readonly MutationRecord[]): void {
    if (!this.enabled || this.#overlay === undefined) {
      return;
    }
    for (const mutation of mutations) {
      if (this.#isOverlayNode(mutation.target)) {
        continue;
      }
      switch (mutation.type) {
        case "attributes": {
          this.#recordElementMutation(
            mutation,
            "attribute",
            mutation.attributeName ?? undefined,
          );
          break;
        }
        case "characterData": {
          this.#recordElementMutation(mutation, "text");
          break;
        }
        case "childList": {
          this.#recordChildListMutation(mutation);
          break;
        }
      }
    }
  }
  #recordElementMutation(
    mutation: MutationRecord,
    kind: "attribute" | "text",
    attributeName?: string,
  ): void {
    if (
      kind === "attribute" &&
      attributeName !== undefined &&
      SENSITIVE_ATTRIBUTES.has(attributeName.toLowerCase())
    ) {
      return;
    }
    const target = this.#observedElement(mutation.target);
    if (target !== null) {
      this.#record(target, kind, 1, attributeName);
    }
  }
  #recordChildListMutation(mutation: MutationRecord): void {
    const parent = this.#observedElement(mutation.target);
    if (parent === null) {
      return;
    }
    this.#recordNodeChanges(parent, mutation.addedNodes, "insert");
    this.#recordNodeChanges(parent, mutation.removedNodes, "remove");
    for (const added of mutation.addedNodes) {
      this.#recordInsertedElements(added);
    }
    for (const removed of mutation.removedNodes) {
      this.#forgetRemovedElements(removed);
    }
  }
  #recordNodeChanges(
    parent: Element,
    nodes: NodeList,
    kind: "insert" | "remove",
  ): void {
    const textCount = this.#textNodeCount(nodes);
    if (textCount > 0) {
      this.#record(parent, "text", textCount);
    }
    const elementCount = nodes.length - textCount;
    if (elementCount > 0) {
      this.#record(parent, kind, elementCount);
    }
  }
  #textNodeCount(nodes: NodeList): number {
    let count = 0;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes.item(index);
      if (node !== null && node.nodeType === Node.TEXT_NODE) {
        count += 1;
      }
    }
    return count;
  }
  #recordInsertedElements(node: Node): void {
    if (!(node instanceof Element)) return;
    this.#recordInsertedElement(node);
    const descendants = node.querySelectorAll("*");
    for (let index = 0; index < descendants.length; index += 1) {
      this.#recordInsertedElement(descendants.item(index));
    }
  }
  #recordInsertedElement(element: Element): void {
    if (this.#includes(element)) {
      this.#record(element, "insert");
    }
  }
  #forgetRemovedElements(node: Node): void {
    if (!(node instanceof Element)) {
      return;
    }
    this.#removeContainedHighlights(node);
    this.#removeContainedKeys(this.#summaries, node);
    this.#removeContainedKeys(this.#pending, node);
  }
  #removeContainedKeys(
    values: Map<Element, MutationSummary>,
    node: Element,
  ): void {
    for (const element of values.keys()) {
      if (element === node || node.contains(element)) {
        values.delete(element);
      }
    }
  }
  #removeContainedHighlights(node: Element): void {
    for (const [element, highlight] of this.#highlights) {
      if (element === node || node.contains(element)) {
        highlight.remove();
        this.#highlights.delete(element);
      }
    }
  }
  #observedElement(node: Node): Element | null {
    const element = nearestElement(node);
    return element !== null && this.#includes(element) ? element : null;
  }
  #includes(element: Element): boolean {
    const root = this.#root;
    return (
      root !== undefined &&
      !this.#isOverlayNode(element) &&
      element.isConnected &&
      element.ownerDocument === root.ownerDocument
    );
  }
  #isOverlayNode(node: Node): boolean {
    const overlay = this.#overlay;
    return (
      overlay !== undefined && (node === overlay || overlay.contains(node))
    );
  }
  #record(
    element: Element,
    kind: RenderDebugMutationKind,
    count = 1,
    attributeName?: string,
  ): void {
    let summary = this.#pending.get(element);
    if (summary === undefined) {
      summary = createMutationSummary();
      this.#pending.set(element, summary);
    }
    this.#incrementSummary(summary, kind, count, attributeName);
    this.#addSummary(element, kind, count, attributeName);
    this.#scheduleFrame();
  }
  #addSummary(
    element: Element,
    kind: RenderDebugMutationKind,
    count: number,
    attributeName?: string,
  ): void {
    const summary = this.#summaryFor(element);
    this.#incrementSummary(summary, kind, count, attributeName);
  }
  #summaryFor(element: Element): MutationSummary {
    let summary = this.#summaries.get(element);
    if (summary === undefined) {
      if (this.#summaries.size >= MAXIMUM_SUMMARIES) {
        const oldest = this.#summaries.keys().next().value;
        if (oldest !== undefined) this.#summaries.delete(oldest);
      }
      summary = createMutationSummary();
      this.#summaries.set(element, summary);
    }
    return summary;
  }
  #incrementSummary(
    summary: MutationSummary,
    kind: RenderDebugMutationKind,
    count: number,
    attributeName?: string,
  ): void {
    summary.counts.set(kind, (summary.counts.get(kind) ?? 0) + count);
    if (attributeName !== undefined) summary.attributeNames.add(attributeName);
  }
  #scheduleFrame(): void {
    if (
      this.#animationFrame !== undefined ||
      this.#browserWindow === undefined ||
      this.#overlay === undefined
    ) {
      return;
    }
    this.#animationFrame = this.#browserWindow.requestAnimationFrame(() => {
      this.#flush();
    });
  }
  #flush(): void {
    this.#animationFrame = undefined;
    if (!this.enabled || this.#highlightLayer === undefined) {
      return;
    }
    const updates = [...this.#pending].slice(-MAXIMUM_HIGHLIGHTS);
    this.#pending.clear();
    const visibleUpdates: [Element, MutationSummary][] = [];
    for (const [element, summary] of updates) {
      if (this.#includes(element) && this.#matchesFilter(element)) {
        const bounds = element.getBoundingClientRect();
        if (this.#isVisible(bounds)) {
          visibleUpdates.push([element, summary]);
        }
      }
    }
    for (const [element, summary] of visibleUpdates) {
      this.#showHighlight(element, summary);
    }
    this.#positionHighlights();
    this.#renderDetails();
  }
  #renderDetails(): void {
    const details = this.#details;
    if (details === undefined) {
      return;
    }
    const rows = [...this.#summaries]
      .filter(
        ([element]) => this.#includes(element) && this.#matchesFilter(element),
      )
      .sort(
        (first, second) =>
          this.#summaryCount(second[1]) - this.#summaryCount(first[1]),
      )
      .slice(0, MAXIMUM_DETAIL_ROWS);
    details.replaceChildren();
    for (const [element, summary] of rows) {
      const row = element.ownerDocument.createElement("span");
      const count = this.#summaryCount(summary);
      row.textContent = `${elementLabel(element)} · ${String(count)} ${count === 1 ? "mutation" : "mutations"}`;
      details.append(row);
    }
  }
  #summaryCount(summary: MutationSummary): number {
    let count = 0;
    for (const amount of summary.counts.values()) {
      count += amount;
    }
    return count;
  }
  #isVisible(bounds: DOMRect): boolean {
    const browserWindow = this.#browserWindow;
    return (
      browserWindow !== undefined &&
      bounds.bottom >= 0 &&
      bounds.right >= 0 &&
      bounds.top <= browserWindow.innerHeight &&
      bounds.left <= browserWindow.innerWidth
    );
  }
  #positionHighlights(): void {
    for (const [element, highlight] of this.#highlights) {
      const included = this.#includes(element);
      const bounds = included ? element.getBoundingClientRect() : undefined;
      if (bounds !== undefined && this.#isVisible(bounds)) {
        this.#positionHighlight(bounds, highlight);
      } else {
        highlight.remove();
        this.#highlights.delete(element);
      }
    }
  }
  #showHighlight(element: Element, summary: MutationSummary): void {
    const document = element.ownerDocument;
    const highlight = document.createElement("div");
    const kinds = MUTATION_KINDS.filter(
      (kind) => (summary.counts.get(kind) ?? 0) > 0,
    );
    const insertedCount = [...summary.counts.entries()].reduce(
      (count, [kind, amount]) =>
        kind === "initial" || kind === "insert" ? count + amount : count,
      0,
    );
    const sequence = String(insertedCount % 6);
    const bounds = element.getBoundingClientRect();
    highlight.style.setProperty("--render-debug-sequence", sequence);
    highlight.classList.add(
      "render-debug-highlight",
      ...kinds.map((kind) => `render-debug-highlight--${kind}`),
    );
    if (kinds.length > 1)
      highlight.classList.add("render-debug-highlight--mixed");
    const label = document.createElement("span");
    label.className = "render-debug-highlight__label";
    label.textContent = `${elementLabel(element)} · ${mutationDescription(summary)}`;
    highlight.append(label);
    const previous = this.#highlights.get(element);
    previous?.remove();
    if (previous === undefined && this.#highlights.size >= MAXIMUM_HIGHLIGHTS) {
      const oldest = this.#highlights.entries().next().value;
      if (oldest !== undefined) {
        oldest[1].remove();
        this.#highlights.delete(oldest[0]);
      }
    }
    this.#highlights.set(element, highlight);
    this.#highlightLayer?.append(highlight);
    this.#positionHighlight(bounds, highlight);
    highlight.addEventListener(
      "animationend",
      () => {
        if (this.#highlights.get(element) === highlight) {
          this.#highlights.delete(element);
          highlight.remove();
        }
      },
      { once: true },
    );
  }
  #positionHighlight(bounds: DOMRect, highlight: HTMLElement): void {
    highlight.style.height = `${String(Math.max(bounds.height, 1))}px`;
    highlight.style.transform = `translate3d(${String(bounds.left)}px, ${String(bounds.top)}px, 0)`;
    highlight.style.width = `${String(Math.max(bounds.width, 1))}px`;
  }
}
export function RenderDebugToggle(props: {
  readonly instrumentation: RenderDebugInstrumentation;
}): JSX.Element {
  return (
    <button
      aria-pressed={props.instrumentation.enabledView()}
      class={`rounded-full border px-3 py-1 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300 ${props.instrumentation.enabledView() ? "border-amber-300/40 bg-amber-300/15 text-amber-100" : "border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200"}`}
      onClick={() => {
        props.instrumentation.toggle();
      }}
      type="button"
    >
      Render debug
    </button>
  );
}
