import { onCleanup } from "solid-js";

interface NestedScrollState {
  readonly fromEnd: number;
  readonly fromRight: number;
  readonly left: number;
  readonly lineWrap: boolean | undefined;
  readonly top: number;
}

interface RememberedNestedScroll {
  readonly element: HTMLElement;
  readonly states: readonly NestedScrollState[];
}

interface NestedScrollMutation {
  readonly added: readonly HTMLElement[];
  readonly mutationIndex: number;
  readonly removed: readonly HTMLElement[];
  readonly target: Node;
}

interface UnmatchedNestedScroll {
  readonly element: HTMLElement;
  readonly mutationIndex: number;
  readonly state: NestedScrollState;
  readonly target: Node;
}

const nestedScrollByMessage = new Map<string, RememberedNestedScroll>();

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

function rememberNestedScroll(
  element: HTMLElement,
  indexed?: WeakMap<HTMLElement, NestedScrollState>,
): readonly NestedScrollState[] {
  return nestedScrollElements(element).map((nested) => {
    const state = nestedScrollState(nested);
    indexed?.set(nested, state);
    return state;
  });
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

function sameScrollKind(left: HTMLElement, right: HTMLElement): boolean {
  return (
    left.localName === right.localName && left.className === right.className
  );
}

function matchingReplacement(
  removed: HTMLElement,
  added: readonly HTMLElement[],
  available: ReadonlySet<HTMLElement>,
  samePosition?: HTMLElement,
): HTMLElement | undefined {
  return samePosition !== undefined &&
    available.has(samePosition) &&
    sameScrollKind(removed, samePosition)
    ? samePosition
    : added.find(
        (candidate) =>
          available.has(candidate) && sameScrollKind(removed, candidate),
      );
}

function updateRememberedReplacement(
  element: HTMLElement,
  nestedScrollByElement: WeakMap<HTMLElement, NestedScrollState>,
  mutations: readonly MutationRecord[],
): void {
  const paneMutations = mutations.flatMap(
    (mutation, mutationIndex): readonly NestedScrollMutation[] => {
      const removed = nestedScrollElementsIn(mutation.removedNodes);
      const added = nestedScrollElementsIn(mutation.addedNodes);
      return removed.length === 0 && added.length === 0
        ? []
        : [{ added, mutationIndex, removed, target: mutation.target }];
    },
  );
  if (paneMutations.length === 0) return;

  const available = new Set(
    paneMutations
      .flatMap(({ added }) => added)
      .filter((candidate) => element.contains(candidate)),
  );
  const unmatched: UnmatchedNestedScroll[] = [];
  for (const mutation of paneMutations) {
    for (const [index, removedElement] of mutation.removed.entries()) {
      const state = nestedScrollByElement.get(removedElement);
      if (state === undefined) continue;
      const replacement = matchingReplacement(
        removedElement,
        mutation.added,
        available,
        mutation.added[index],
      );
      if (replacement === undefined) {
        unmatched.push({
          element: removedElement,
          mutationIndex: mutation.mutationIndex,
          state,
          target: mutation.target,
        });
      } else {
        available.delete(replacement);
        restoreNestedScroll(replacement, state);
      }
    }
  }
  for (const removed of unmatched) {
    const laterSameTarget = paneMutations.flatMap((mutation) =>
      mutation.target === removed.target &&
      mutation.mutationIndex > removed.mutationIndex
        ? mutation.added
        : [],
    );
    const replacement = matchingReplacement(
      removed.element,
      laterSameTarget,
      available,
    );
    if (replacement !== undefined) {
      available.delete(replacement);
      restoreNestedScroll(replacement, removed.state);
    }
  }
  rememberNestedScroll(element, nestedScrollByElement);
}

export function createNestedScrollRef(
  messageId: () => string,
  observeReplacements = false,
): (element: HTMLElement) => void {
  let current: HTMLElement | undefined;
  let currentKey: string | undefined;
  let remember: ((event?: Event) => void) | undefined;
  const nestedScrollByElement = new WeakMap<HTMLElement, NestedScrollState>();
  onCleanup(() => {
    if (current !== undefined && remember !== undefined) {
      current.removeEventListener("scroll", remember, true);
      current.removeEventListener("subscroll-wrap-change", remember);
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
  return (element) => {
    const key = messageId();
    currentKey = key;
    const previous = nestedScrollByMessage.get(key);
    current = element;
    if (previous !== undefined && previous.element !== element) {
      queueMicrotask(() => {
        const nested = nestedScrollElements(element);
        for (const [index, state] of previous.states.entries()) {
          const scroll = nested[index];
          if (scroll !== undefined) restoreNestedScroll(scroll, state);
        }
      });
    }
    remember = (event?: Event) => {
      const states = rememberNestedScroll(element, nestedScrollByElement);
      const changedWrap =
        event instanceof CustomEvent && typeof event.detail === "boolean"
          ? event.detail
          : undefined;
      const changedPane =
        changedWrap === undefined || !(event?.target instanceof HTMLElement)
          ? undefined
          : event.target.querySelector<HTMLElement>("[data-line-wrap]");
      const changedIndex =
        changedPane === undefined || changedPane === null
          ? -1
          : nestedScrollElements(element).indexOf(changedPane);
      nestedScrollByMessage.set(key, {
        element,
        states:
          changedIndex === -1
            ? states
            : states.map((state, index) =>
                index === changedIndex
                  ? { ...state, lineWrap: changedWrap }
                  : state,
              ),
      });
    };
    element.addEventListener("scroll", remember, true);
    element.addEventListener("subscroll-wrap-change", remember);
    if (!observeReplacements) return;

    const observer = new MutationObserver((mutations) => {
      updateRememberedReplacement(element, nestedScrollByElement, mutations);
    });
    observer.observe(element, { childList: true, subtree: true });
    onCleanup(() => {
      observer.disconnect();
    });
  };
}
