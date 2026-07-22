import { expect, test } from "vitest";
import { updatePreservingFocus } from "../../solid/focus-position.ts";

type SelectionDirection = "backward" | "forward" | "none";

class FocusTarget {
  focusOptions: FocusOptions | undefined;
  readonly key: string | null;
  scrollLeft: number;
  scrollTop: number;
  selectionDirection: SelectionDirection | null;
  selectionEnd: number | null;
  selectionStart: number | null;

  constructor(options: {
    readonly key: string | null;
    readonly scrollLeft?: number;
    readonly scrollTop?: number;
    readonly selectionDirection?: SelectionDirection | null;
    readonly selectionEnd?: number | null;
    readonly selectionStart?: number | null;
  }) {
    this.key = options.key;
    this.scrollLeft = options.scrollLeft ?? 0;
    this.scrollTop = options.scrollTop ?? 0;
    this.selectionDirection = options.selectionDirection ?? null;
    this.selectionEnd = options.selectionEnd ?? null;
    this.selectionStart = options.selectionStart ?? null;
  }

  focus(options?: FocusOptions): void {
    this.focusOptions = options;
  }

  getAttribute(name: string): string | null {
    return name === "data-focus-key" ? this.key : null;
  }

  setSelectionRange(
    start: number,
    end: number,
    direction?: SelectionDirection,
  ): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? "none";
  }
}

test("restores a keyed control's focus, selection, and scroll after an update", () => {
  const previous = new FocusTarget({
    key: "session-prompt",
    scrollLeft: 4,
    scrollTop: 30,
    selectionDirection: "backward",
    selectionEnd: 18,
    selectionStart: 7,
  });
  const replacement = new FocusTarget({
    key: "session-prompt",
    selectionEnd: 0,
    selectionStart: 0,
  });
  let updated = false;

  updatePreservingFocus(
    () => (updated ? replacement : previous),
    (key) => (key === replacement.key ? replacement : null),
    () => {
      updated = true;
    },
  );

  expect(replacement.focusOptions).toEqual({ preventScroll: true });
  expect(replacement.selectionStart).toBe(7);
  expect(replacement.selectionEnd).toBe(18);
  expect(replacement.selectionDirection).toBe("backward");
  expect(replacement.scrollLeft).toBe(4);
  expect(replacement.scrollTop).toBe(30);
});

test("does not move focus when the active control has no focus key", () => {
  const previous = new FocusTarget({ key: null });
  const replacement = new FocusTarget({ key: "session-prompt" });
  let updated = false;

  updatePreservingFocus(
    () => previous,
    () => replacement,
    () => {
      updated = true;
    },
  );

  expect(updated).toBe(true);
  expect(replacement.focusOptions).toBeUndefined();
});
