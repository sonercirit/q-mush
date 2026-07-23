import { createSignal, type Accessor, type JSX, type Setter } from "solid-js";

type RenderDebugMutationKind =
  "attribute" | "initial" | "insert" | "remove" | "text";

interface MutationSummary {
  readonly attributeNames: Set<string>;
  readonly counts: Map<RenderDebugMutationKind, number>;
}

interface RenderDebugOverlay {
  readonly highlights: HTMLDivElement;
  readonly root: HTMLDivElement;
}

const MUTATION_KINDS: readonly RenderDebugMutationKind[] = [
  "initial",
  "insert",
  "remove",
  "text",
  "attribute",
];

function createMutationSummary(): MutationSummary {
  return { attributeNames: new Set(), counts: new Map() };
}

function clipped(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

function elementLabel(element: Element): string {
  const id = element.id.length === 0 ? "" : `#${clipped(element.id, 32)}`;
  if (id.length > 0) {
    return `${element.localName}${id}`;
  }

  const accessibleLabel = element.getAttribute("aria-label")?.trim();
  return accessibleLabel === undefined || accessibleLabel.length === 0
    ? element.localName
    : `${element.localName} “${clipped(accessibleLabel, 36)}”`;
}

function mutationDescription(summary: MutationSummary): string {
  return MUTATION_KINDS.flatMap((kind) => {
    const count = summary.counts.get(kind) ?? 0;
    if (count === 0) {
      return [];
    }

    const amount = count === 1 ? "" : ` ×${String(count)}`;
    if (kind !== "attribute" || summary.attributeNames.size === 0) {
      return [`${kind}${amount}`];
    }

    const names = clipped([...summary.attributeNames].join(", "), 44);
    return [`${kind}${amount} (${names})`];
  }).join(" · ");
}

function appendLegendRow(
  document: Document,
  legend: HTMLElement,
  kind: Exclude<RenderDebugMutationKind, "initial">,
): void {
  const row = document.createElement("span");
  const swatch = document.createElement("span");
  swatch.className = `render-debug-legend__swatch render-debug-legend__swatch--${kind}`;
  row.append(swatch, kind);
  legend.append(row);
}

function createOverlay(document: Document): RenderDebugOverlay {
  const root = document.createElement("div");
  root.id = "render-debug-overlay";
  root.className = "render-debug-overlay";
  root.setAttribute("aria-hidden", "true");

  const highlights = document.createElement("div");
  highlights.className = "render-debug-highlights";

  const legend = document.createElement("aside");
  legend.className = "render-debug-legend";
  const title = document.createElement("strong");
  title.textContent = "DOM updates";
  const description = document.createElement("span");
  description.textContent = "Every element is instrumented automatically";
  legend.append(title, description);
  appendLegendRow(document, legend, "insert");
  appendLegendRow(document, legend, "remove");
  appendLegendRow(document, legend, "text");
  appendLegendRow(document, legend, "attribute");

  root.append(highlights, legend);
  return { highlights, root };
}

function nearestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

export class RenderDebugInstrumentation {
  readonly #enabled: Accessor<boolean>;
  readonly #highlights = new Map<Element, HTMLDivElement>();
  readonly #pending = new Map<Element, MutationSummary>();
  readonly #setEnabled: Setter<boolean>;
  #animationFrame: number | undefined;
  #browserWindow: Window | undefined;
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

    const overlay = createOverlay(root.ownerDocument);
    root.ownerDocument.body.append(overlay.root);
    const Observer = browserWindow.MutationObserver;
    const observer = new Observer((mutations) => {
      this.#recordMutations(mutations);
    });
    observer.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    root.ownerDocument.addEventListener("scroll", this.#viewportChanged, true);
    browserWindow.addEventListener("resize", this.#viewportChanged);

    this.#browserWindow = browserWindow;
    this.#highlightLayer = overlay.highlights;
    this.#observer = observer;
    this.#overlay = overlay.root;

    this.#record(root, "initial");
    for (const element of root.querySelectorAll("*")) {
      if (this.#includes(element)) {
        this.#record(element, "initial");
      }
    }
  }

  #stop(): void {
    this.#observer?.disconnect();
    this.#root?.ownerDocument.removeEventListener(
      "scroll",
      this.#viewportChanged,
      true,
    );
    this.#browserWindow?.removeEventListener("resize", this.#viewportChanged);
    if (
      this.#animationFrame !== undefined &&
      this.#browserWindow !== undefined
    ) {
      this.#browserWindow.cancelAnimationFrame(this.#animationFrame);
    }

    this.#overlay?.remove();
    this.#highlights.clear();
    this.#pending.clear();
    this.#animationFrame = undefined;
    this.#browserWindow = undefined;
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

    if (mutation.addedNodes.length > 0) {
      this.#record(parent, "insert", mutation.addedNodes.length);
      for (const added of mutation.addedNodes) {
        this.#recordInsertedElements(added);
      }
    }

    if (mutation.removedNodes.length > 0) {
      this.#record(parent, "remove", mutation.removedNodes.length);
      for (const removed of mutation.removedNodes) {
        this.#forgetRemovedElements(removed);
      }
    }
  }

  #recordInsertedElements(node: Node): void {
    if (node instanceof Element) {
      this.#recordInsertedElement(node);
      for (const descendant of node.querySelectorAll("*")) {
        this.#recordInsertedElement(descendant);
      }
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
    for (const element of this.#pending.keys()) {
      if (element === node || node.contains(element)) {
        this.#pending.delete(element);
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
    if (root === undefined || this.#isOverlayNode(element)) {
      return false;
    }
    return element === root || root.contains(element);
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
    summary.counts.set(kind, (summary.counts.get(kind) ?? 0) + count);
    if (attributeName !== undefined) {
      summary.attributeNames.add(attributeName);
    }
    this.#scheduleFrame();
  }

  #scheduleFrame(): void {
    if (
      this.#animationFrame !== undefined ||
      this.#browserWindow === undefined ||
      this.#overlay === undefined
    ) {
      return;
    }

    this.#animationFrame = this.#browserWindow.requestAnimationFrame(
      (timestamp) => {
        this.#flush(timestamp);
      },
    );
  }

  #flush(timestamp: DOMHighResTimeStamp): void {
    this.#animationFrame = undefined;
    if (!this.enabled || this.#highlightLayer === undefined) {
      return;
    }

    const updates = [...this.#pending];
    this.#pending.clear();
    for (const [element, summary] of updates) {
      if (this.#includes(element)) {
        this.#showHighlight(element, summary, timestamp);
      }
    }

    this.#positionHighlights();
  }

  #positionHighlights(): void {
    for (const [element, highlight] of this.#highlights) {
      const included = this.#includes(element);
      if (included) {
        this.#positionHighlight(element, highlight);
      } else {
        highlight.remove();
        this.#highlights.delete(element);
      }
    }
  }

  #showHighlight(
    element: Element,
    summary: MutationSummary,
    timestamp: DOMHighResTimeStamp,
  ): void {
    const document = element.ownerDocument;
    const highlight = document.createElement("div");
    const kinds = MUTATION_KINDS.filter(
      (kind) => (summary.counts.get(kind) ?? 0) > 0,
    );
    const sequence = String(Math.round(timestamp / 16) % 6);
    highlight.style.setProperty("--render-debug-sequence", sequence);
    highlight.classList.add(
      "render-debug-highlight",
      ...kinds.map((kind) => `render-debug-highlight--${kind}`),
    );
    if (kinds.length > 1) {
      highlight.classList.add("render-debug-highlight--mixed");
    }

    const label = document.createElement("span");
    label.className = "render-debug-highlight__label";
    label.textContent = `${elementLabel(element)} · ${mutationDescription(summary)}`;
    highlight.append(label);

    const previous = this.#highlights.get(element);
    previous?.remove();
    this.#highlights.set(element, highlight);
    this.#highlightLayer?.append(highlight);
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

  #positionHighlight(element: Element, highlight: HTMLElement): void {
    const bounds = element.getBoundingClientRect();
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
