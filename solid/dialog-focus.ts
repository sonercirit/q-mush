import { createEffect, on, onMount } from "solid-js";

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
