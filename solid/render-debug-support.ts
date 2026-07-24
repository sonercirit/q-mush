export type RenderDebugMutationKind =
  "attribute" | "initial" | "insert" | "remove" | "text";

export interface MutationSummary {
  readonly attributeNames: Set<string>;
  readonly counts: Map<RenderDebugMutationKind, number>;
}

export interface RenderDebugOverlay {
  readonly details: HTMLDivElement;
  readonly filter: HTMLSelectElement;
  readonly highlights: HTMLDivElement;
  readonly root: HTMLDivElement;
}

export const MAXIMUM_DETAIL_ROWS = 10;
export const MAXIMUM_HIGHLIGHTS = 100;
export const MAXIMUM_SUMMARIES = 100;
export const SENSITIVE_ATTRIBUTES = new Set(["value"]);
export const MUTATION_KINDS: readonly RenderDebugMutationKind[] = [
  "initial",
  "insert",
  "remove",
  "text",
  "attribute",
];

export function createMutationSummary(): MutationSummary {
  return { attributeNames: new Set(), counts: new Map() };
}

function clipped(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 1)}…`;
}

export function elementLabel(element: Element): string {
  const id = element.id.length === 0 ? "" : `#${clipped(element.id, 32)}`;
  if (id.length > 0) {
    return `${element.localName}${id}`;
  }

  const accessibleLabel = element.getAttribute("aria-label")?.trim();
  return accessibleLabel === undefined || accessibleLabel.length === 0
    ? element.localName
    : `${element.localName} “${clipped(accessibleLabel, 36)}”`;
}

export function mutationDescription(summary: MutationSummary): string {
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

export function createOverlay(document: Document): RenderDebugOverlay {
  const root = document.createElement("div");
  root.id = "render-debug-overlay";
  root.className = "render-debug-overlay";

  const highlights = document.createElement("div");
  highlights.className = "render-debug-highlights";
  highlights.setAttribute("aria-hidden", "true");

  const legend = document.createElement("aside");
  legend.className = "render-debug-legend";
  legend.setAttribute("aria-label", "Render debug details");
  const title = document.createElement("strong");
  title.textContent = "DOM updates";
  legend.append(title, "Every element is instrumented automatically");
  appendLegendRow(document, legend, "insert");
  appendLegendRow(document, legend, "remove");
  appendLegendRow(document, legend, "text");
  appendLegendRow(document, legend, "attribute");

  const filterId = "render-debug-filter";
  const filterLabel = document.createElement("label");
  filterLabel.className = "render-debug-legend__control";
  filterLabel.setAttribute("for", filterId);
  filterLabel.append("Filter");
  const filter = document.createElement("select");
  filter.id = filterId;
  const allElements = document.createElement("option");
  allElements.value = "";
  allElements.textContent = "All elements";
  const interactive = document.createElement("option");
  interactive.value = "button, input, select, textarea, a[href]";
  interactive.textContent = "Interactive";
  const transcript = document.createElement("option");
  transcript.value =
    "[data-session-transcript] > li:not(:first-child):not(:nth-child(2))";
  transcript.textContent = "Transcript messages";
  filter.append(allElements, interactive, transcript);
  filterLabel.append(filter);
  const details = document.createElement("div");
  details.className = "render-debug-legend__details";
  legend.append(filterLabel, details);

  root.append(highlights, legend);
  return { details, filter, highlights, root };
}

export function observeMutations(
  observer: MutationObserver,
  body: HTMLElement,
): void {
  observer.observe(body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
}

export function mutationObserverFor(
  browserWindow: Window,
): typeof MutationObserver | undefined {
  return Reflect.has(browserWindow, "MutationObserver")
    ? MutationObserver
    : undefined;
}

export function nearestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}
