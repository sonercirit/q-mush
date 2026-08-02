import { createEffect, on, onCleanup, onMount } from "solid-js";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function dialogFocusableElements(
  dialog: HTMLElement | undefined,
): readonly HTMLElement[] {
  return dialog === undefined
    ? []
    : [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
}

function trapDialogFocus(
  event: KeyboardEvent,
  dialog: HTMLElement | undefined,
): void {
  if (event.key !== "Tab" || dialog === undefined) return;
  const focusable = dialogFocusableElements(dialog);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialog.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export interface DialogFocusOptions {
  readonly dialog: () => HTMLElement | undefined;
  readonly onEscape: () => void;
  readonly open: () => boolean;
  readonly returnFocus: () => HTMLElement | undefined;
}

export function setupDialogFocus(options: DialogFocusOptions): void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!options.open()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      options.onEscape();
      return;
    }
    trapDialogFocus(event, options.dialog());
  };
  restoreDialogFocus(
    options.open,
    () => {
      queueMicrotask(() => {
        dialogFocusableElements(options.dialog())[0]?.focus();
      });
    },
    options.returnFocus,
  );
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
    });
  });
}

export function restoreDialogFocus(
  open: () => boolean,
  focusOpen: () => void,
  returnTarget: () => HTMLElement | undefined,
): void {
  onMount(() => {
    createEffect(
      on(open, (isOpen, wasOpen) => {
        if (isOpen) {
          focusOpen();
        } else if (wasOpen) {
          const target = returnTarget();
          queueMicrotask(() => {
            if (target?.isConnected !== false) {
              target?.focus({ preventScroll: true });
            }
          });
        }
      }),
    );
  });
}
