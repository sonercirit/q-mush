interface FocusTarget {
  getAttribute(name: string): string | null;
  scrollLeft: number;
  scrollTop: number;
}

interface FocusableTarget extends FocusTarget {
  focus(options?: FocusOptions): void;
}

interface SelectionTarget extends FocusableTarget {
  readonly selectionDirection: "backward" | "forward" | "none" | null;
  readonly selectionEnd: number | null;
  readonly selectionStart: number | null;
  setSelectionRange(
    start: number,
    end: number,
    direction?: "backward" | "forward" | "none",
  ): void;
}

type FindFocusTarget = (key: string) => FocusTarget | null;
type ReadFocusTarget = () => FocusTarget | null;

function isFocusableTarget(target: FocusTarget): target is FocusableTarget {
  return "focus" in target && typeof target.focus === "function";
}

function isSelectionTarget(target: FocusTarget): target is SelectionTarget {
  return (
    "selectionDirection" in target &&
    "selectionEnd" in target &&
    "selectionStart" in target &&
    "setSelectionRange" in target
  );
}

export function updatePreservingFocus(
  readActiveTarget: ReadFocusTarget,
  findTarget: FindFocusTarget,
  update: () => void,
): void {
  const activeTarget = readActiveTarget();
  const key = activeTarget?.getAttribute("data-focus-key");
  const position =
    activeTarget === null
      ? undefined
      : { left: activeTarget.scrollLeft, top: activeTarget.scrollTop };
  const selection =
    activeTarget !== null &&
    isSelectionTarget(activeTarget) &&
    activeTarget.selectionStart !== null &&
    activeTarget.selectionEnd !== null
      ? {
          direction: activeTarget.selectionDirection ?? "none",
          end: activeTarget.selectionEnd,
          start: activeTarget.selectionStart,
        }
      : undefined;

  update();

  if (key === null || key === undefined || position === undefined) {
    return;
  }

  const replacement = findTarget(key);
  if (replacement === null || !isFocusableTarget(replacement)) {
    return;
  }

  replacement.focus({ preventScroll: true });
  if (selection !== undefined && isSelectionTarget(replacement)) {
    replacement.setSelectionRange(
      selection.start,
      selection.end,
      selection.direction,
    );
  }
  replacement.scrollLeft = position.left;
  replacement.scrollTop = position.top;
}
