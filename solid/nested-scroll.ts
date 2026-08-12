import { createRenderEffect, onCleanup } from "solid-js";

interface NestedScrollState {
  readonly fromEnd: number;
  readonly fromRight: number;
  readonly left: number;
  readonly lineWrap: boolean | undefined;
  readonly top: number;
}

interface RememberedNestedScrollPane {
  readonly element: HTMLElement;
  readonly state: NestedScrollState;
}

interface RememberedNestedScroll {
  readonly element: HTMLElement;
  readonly panes: ReadonlyMap<number, RememberedNestedScrollPane>;
}

interface ElementNestedScrollState {
  readonly key: string;
  readonly state: NestedScrollState;
}

const nestedScrollByElement = new WeakMap<
  HTMLElement,
  ElementNestedScrollState
>();
const nestedScrollByMessage = new Map<string, RememberedNestedScroll>();

const NESTED_SCROLL_KEY_ATTRIBUTE = "data-nested-scroll-key";
const NESTED_SCROLL_SELECTOR =
  ".overflow-auto, .overflow-x-auto, .overflow-y-auto:not(.session-transcript)";

function nestedScrollElements(element: HTMLElement): readonly HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(NESTED_SCROLL_SELECTOR)];
}

function nestedScrollElementsIn(nodes: NodeList): readonly HTMLElement[] {
  return [...nodes].flatMap((node): readonly HTMLElement[] => {
    if (!(node instanceof HTMLElement)) return [];
    return [
      ...(node.matches(NESTED_SCROLL_SELECTOR) ? [node] : []),
      ...nestedScrollElements(node),
    ];
  });
}

function nestedScrollScope(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>(`[${NESTED_SCROLL_KEY_ATTRIBUTE}]`);
}

function nestedScrollScopeKey(element: HTMLElement): string | undefined {
  return element.dataset["nestedScrollKey"];
}

function ownedNestedScrollElements(
  element: HTMLElement,
): readonly HTMLElement[] {
  return nestedScrollElements(element).filter(
    (nested) => nestedScrollScope(nested) === element,
  );
}

function nestedScrollState(element: HTMLElement): NestedScrollState {
  return {
    fromEnd: element.scrollHeight - element.clientHeight - element.scrollTop,
    fromRight: element.scrollWidth - element.clientWidth - element.scrollLeft,
    left: element.scrollLeft,
    lineWrap:
      element.dataset["lineWrap"] === undefined
        ? undefined
        : element.dataset["lineWrap"] === "true",
    top: element.scrollTop,
  };
}

function restoreNestedScroll(
  element: HTMLElement,
  state: NestedScrollState,
): void {
  if (state.lineWrap !== undefined) {
    element.dispatchEvent(
      new CustomEvent<boolean>("subscroll-wrap-restore", {
        bubbles: true,
        detail: state.lineWrap,
      }),
    );
  }
  element.scrollTop =
    state.fromEnd <= 2
      ? element.scrollHeight - element.clientHeight
      : state.top;
  element.scrollLeft =
    state.fromRight <= 2
      ? element.scrollWidth - element.clientWidth
      : state.left;
}

function recordNestedScrollPane(
  key: string,
  element: HTMLElement,
  state = nestedScrollState(element),
): RememberedNestedScrollPane {
  nestedScrollByElement.set(element, { key, state });
  return { element, state };
}

function recordOwnNestedScrollPanes(key: string, element: HTMLElement): void {
  nestedScrollByMessage.set(key, {
    element,
    panes: currentNestedScrollPanes(key, ownedNestedScrollElements(element)),
  });
}

function currentNestedScrollPanes(
  key: string,
  elements: readonly HTMLElement[],
): ReadonlyMap<number, RememberedNestedScrollPane> {
  return new Map(
    elements.map((element, ordinal) => [
      ordinal,
      recordNestedScrollPane(key, element),
    ]),
  );
}

function rebuiltNestedScrollPanes(
  key: string,
  elements: readonly HTMLElement[],
  previous: RememberedNestedScroll,
): ReadonlyMap<number, RememberedNestedScrollPane> {
  const previousElements = new Set(
    [...previous.panes.values()].map((pane) => pane.element),
  );
  const hasSurvivingElement = elements.some((element) =>
    previousElements.has(element),
  );
  const canRestoreByOrdinal =
    !hasSurvivingElement && elements.length === previous.panes.size;
  const currentElements = new Set(elements);
  for (const pane of previous.panes.values()) {
    if (currentElements.has(pane.element)) continue;
    if (nestedScrollByElement.get(pane.element)?.key === key) {
      nestedScrollByElement.delete(pane.element);
    }
  }
  return new Map(
    elements.map((element, ordinal) => {
      const elementState = nestedScrollByElement.get(element);
      const state = previousElements.has(element)
        ? elementState?.key === key
          ? elementState.state
          : undefined
        : canRestoreByOrdinal
          ? previous.panes.get(ordinal)?.state
          : undefined;
      if (state !== undefined) restoreNestedScroll(element, state);
      return [ordinal, recordNestedScrollPane(key, element)];
    }),
  );
}

function rememberNestedScroll(event: Event): void {
  if (!(event.target instanceof HTMLElement)) return;
  const changedWrap =
    event instanceof CustomEvent && typeof event.detail === "boolean"
      ? event.detail
      : undefined;
  const changedPane =
    changedWrap === undefined
      ? event.target.matches(NESTED_SCROLL_SELECTOR)
        ? event.target
        : undefined
      : event.target.matches("[data-line-wrap]")
        ? event.target
        : (event.target.querySelector<HTMLElement>("[data-line-wrap]") ??
          undefined);
  if (changedPane === undefined) return;
  const scope = nestedScrollScope(changedPane);
  if (scope === null) return;
  const key = nestedScrollScopeKey(scope);
  if (key === undefined) return;
  const nested = ownedNestedScrollElements(scope);
  const panes = currentNestedScrollPanes(key, nested);
  const changedOrdinal = nested.indexOf(changedPane);
  const changed = panes.get(changedOrdinal);
  nestedScrollByMessage.set(key, {
    element: scope,
    panes:
      changedWrap === undefined || changed === undefined
        ? panes
        : new Map(panes).set(
            changedOrdinal,
            recordNestedScrollPane(key, changed.element, {
              ...changed.state,
              lineWrap: changedWrap,
            }),
          ),
  });
}

function restoreRememberedNestedScroll(
  key: string,
  element: HTMLElement,
  previous: RememberedNestedScroll,
): void {
  nestedScrollByMessage.set(key, {
    element,
    panes: rebuiltNestedScrollPanes(
      key,
      ownedNestedScrollElements(element),
      previous,
    ),
  });
}

function addNestedScrollScope(
  scopes: Map<string, Set<HTMLElement>>,
  scope: HTMLElement | null,
): void {
  if (scope !== null) {
    const key = nestedScrollScopeKey(scope);
    if (key !== undefined) {
      const candidates = scopes.get(key) ?? new Set<HTMLElement>();
      candidates.add(scope);
      scopes.set(key, candidates);
    }
  }
}

function changedNestedScrollScopes(
  mutations: readonly MutationRecord[],
): ReadonlyMap<string, ReadonlySet<HTMLElement>> | null {
  const scopes = new Map<string, Set<HTMLElement>>();
  let changed = false;
  for (const mutation of mutations) {
    const added = nestedScrollElementsIn(mutation.addedNodes);
    const removed = nestedScrollElementsIn(mutation.removedNodes);
    if (added.length === 0 && removed.length === 0) continue;
    changed = true;
    addNestedScrollScope(
      scopes,
      mutation.target instanceof HTMLElement
        ? nestedScrollScope(mutation.target)
        : mutation.target.parentElement === null
          ? null
          : nestedScrollScope(mutation.target.parentElement),
    );
    for (const pane of [...added, ...removed]) {
      addNestedScrollScope(scopes, nestedScrollScope(pane));
    }
  }
  return changed ? scopes : null;
}

function rebuildRememberedNestedScroll(
  root: HTMLElement,
  key: string,
  candidates: ReadonlySet<HTMLElement>,
): void {
  const previous = nestedScrollByMessage.get(key);
  if (previous === undefined) return;
  const element = [...candidates].find((candidate) => root.contains(candidate));
  if (element === undefined) {
    nestedScrollByMessage.delete(key);
    return;
  }
  restoreRememberedNestedScroll(key, element, previous);
}

function updateRememberedNestedScroll(
  element: HTMLElement,
  mutations: readonly MutationRecord[],
): void {
  const scopes = changedNestedScrollScopes(mutations);
  if (scopes === null) return;
  for (const [key, candidates] of scopes) {
    rebuildRememberedNestedScroll(element, key, candidates);
  }
}

export function createNestedScrollRef(
  messageId: () => string,
  observeReplacements = false,
): (element: HTMLElement) => void {
  let current: HTMLElement | undefined;
  let currentKey: string | undefined;
  onCleanup(() => {
    if (current !== undefined) {
      current.removeEventListener("scroll", rememberNestedScroll, true);
      current.removeEventListener(
        "subscroll-wrap-change",
        rememberNestedScroll,
      );
    }
    const key = currentKey;
    const element = current;
    queueMicrotask(() => {
      if (
        key !== undefined &&
        nestedScrollByMessage.get(key)?.element === element
      ) {
        nestedScrollByMessage.delete(key);
      }
    });
  });
  const assign = (element: HTMLElement, key: string): void => {
    if (
      currentKey !== undefined &&
      currentKey !== key &&
      nestedScrollByMessage.get(currentKey)?.element === element
    ) {
      nestedScrollByMessage.delete(currentKey);
    }
    currentKey = key;
    const previous = nestedScrollByMessage.get(key);
    current = element;
    element.dataset["nestedScrollKey"] = key;
    if (previous === undefined) {
      recordOwnNestedScrollPanes(key, element);
    } else if (previous.element !== element) {
      nestedScrollByMessage.set(key, { ...previous, element });
      // Restore only when the previous owner really left the document: in a
      // single update a new row can claim a key before the retained old row
      // re-keys itself, and restoring then would copy the retained row's
      // state onto the newcomer. A still-connected owner also means the
      // inherited panes describe that other row, so re-record the claimant's
      // own panes instead of leaving them to restore on a later re-render.
      queueMicrotask(() => {
        if (nestedScrollByMessage.get(key)?.element !== element) return;
        if (previous.element.isConnected) {
          recordOwnNestedScrollPanes(key, element);
          return;
        }
        restoreRememberedNestedScroll(key, element, previous);
      });
    }
  };
  // Retained rows can be re-keyed when the settled transcript prefix grows
  // around a live stream; the bookkeeping must follow the new key or scroll
  // and wrap state is recorded under a stale key and never restored.
  createRenderEffect(() => {
    const key = messageId();
    if (current !== undefined && key !== currentKey) {
      assign(current, key);
    }
  });
  return (element) => {
    assign(element, messageId());
    element.addEventListener("scroll", rememberNestedScroll, true);
    element.addEventListener("subscroll-wrap-change", rememberNestedScroll);
    if (!observeReplacements) return;

    const observer = new MutationObserver((mutations) => {
      updateRememberedNestedScroll(element, mutations);
    });
    observer.observe(element, { childList: true, subtree: true });
    onCleanup(() => {
      observer.disconnect();
    });
  };
}
