import { onCleanup } from "solid-js";

interface NestedScrollState {
  readonly fromEnd: number;
  readonly fromRight: number;
  readonly left: number;
  readonly top: number;
}

interface RememberedNestedScroll {
  readonly element: HTMLElement;
  readonly states: readonly NestedScrollState[];
}

const nestedScrollByMessage = new Map<string, RememberedNestedScroll>();

function nestedScrollElements(element: HTMLElement): readonly HTMLElement[] {
  return [
    ...element.querySelectorAll<HTMLElement>(
      ".max-h-80.overflow-auto, .overflow-x-auto",
    ),
  ];
}

function nestedScrollState(element: HTMLElement): NestedScrollState {
  return {
    fromEnd: element.scrollHeight - element.clientHeight - element.scrollTop,
    fromRight: element.scrollWidth - element.clientWidth - element.scrollLeft,
    left: element.scrollLeft,
    top: element.scrollTop,
  };
}

function restoreNestedScroll(
  element: HTMLElement,
  state: NestedScrollState,
): void {
  element.scrollTop =
    state.fromEnd <= 2
      ? element.scrollHeight - element.clientHeight
      : state.top;
  element.scrollLeft =
    state.fromRight <= 2
      ? element.scrollWidth - element.clientWidth
      : state.left;
}

export function createNestedScrollRef(
  messageId: () => string,
): (element: HTMLElement) => void {
  let current: HTMLElement | undefined;
  let remember: (() => void) | undefined;
  onCleanup(() => {
    if (current !== undefined && remember !== undefined) {
      current.removeEventListener("scroll", remember, true);
    }
    const key = messageId();
    const element = current;
    queueMicrotask(() => {
      if (nestedScrollByMessage.get(key)?.element === element) {
        nestedScrollByMessage.delete(key);
      }
    });
  });
  return (element) => {
    const key = messageId();
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
    remember = () => {
      nestedScrollByMessage.set(key, {
        element,
        states: nestedScrollElements(element).map(nestedScrollState),
      });
    };
    element.addEventListener("scroll", remember, true);
  };
}
