import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { restoreDialogFocus } from "./dialog-focus.ts";
import type { ProviderPanelConfiguration } from "./provider-client.tsx";
import type { SessionReassignmentDialogController } from "./session-reassignment-dialog-controller.ts";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(
  dialog: HTMLElement | undefined,
): readonly HTMLElement[] {
  return dialog === undefined
    ? []
    : [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
}

export function SessionReassignmentDialog(props: {
  readonly configuration: ProviderPanelConfiguration;
  readonly controller: SessionReassignmentDialogController;
  readonly onConfirm: () => void;
  readonly trigger: HTMLElement | undefined;
}): JSX.Element {
  const [dialog, setDialog] = createSignal<HTMLDivElement>();
  const titleId = () => `${props.configuration.id}-session-reassignment-title`;
  const descriptionId = () =>
    `${props.configuration.id}-session-reassignment-description`;
  const close = props.controller.close.bind(props.controller);

  const onKeyDown = (event: KeyboardEvent): void => {
    const current = props.controller.state;
    if (current === undefined) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (!current.pending) {
        close();
      }
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const container = dialog();
    if (container === undefined) {
      return;
    }
    const focusable = focusableElements(container);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      container.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  restoreDialogFocus(
    () => props.controller.state !== undefined,
    () => {
      queueMicrotask(() => {
        focusableElements(dialog())[0]?.focus();
      });
    },
    () => props.trigger,
  );

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  return (
    <Show when={props.controller.state} keyed>
      {(current) => (
        <div
          aria-describedby={descriptionId()}
          aria-labelledby={titleId()}
          aria-modal="true"
          class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
          data-session-reassignment-dialog={props.configuration.id}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
          ref={setDialog}
          role="dialog"
          tabindex="-1"
        >
          <div class="w-full max-w-xl rounded-3xl border border-white/15 bg-slate-900 p-5 shadow-2xl shadow-black/60 sm:p-7">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-xs font-semibold tracking-wider text-cyan-300 uppercase">
                  {props.configuration.name} sessions
                </p>
                <h3
                  class="mt-2 text-xl font-semibold text-white"
                  id={titleId()}
                >
                  Switch sessions to this account?
                </h3>
              </div>
              <button
                aria-label="Close session reassignment dialog"
                class="grid size-9 shrink-0 place-items-center rounded-full border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-white disabled:cursor-wait disabled:opacity-50"
                disabled={current.pending}
                onClick={close}
                type="button"
              >
                ×
              </button>
            </div>

            <div
              class="mt-5 space-y-3 text-sm leading-6 text-slate-300 sm:text-base sm:leading-7"
              id={descriptionId()}
            >
              <p>
                All current and old non-deleted sessions stored as
                {` ${props.configuration.name} `}will use{" "}
                <strong>{current.credential.label}</strong>, including queued,
                running, paused, stopped, and failed sessions.
              </p>
              <p>
                Sessions for other providers will be untouched. Your default
                account will not change. A running turn keeps the account it
                already captured; its next turn uses this account.
              </p>
            </div>

            <Show when={current.error}>
              {(error) => (
                <p
                  class="mt-5 rounded-xl border border-rose-300/20 bg-rose-300/10 p-3 text-sm text-rose-100"
                  role="alert"
                >
                  {error()}
                </p>
              )}
            </Show>

            <div class="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                class="min-h-11 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-white/20 hover:text-white disabled:cursor-wait disabled:opacity-50"
                disabled={current.pending}
                onClick={close}
                type="button"
              >
                Cancel
              </button>
              <button
                class="min-h-11 rounded-xl bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-wait disabled:opacity-60"
                disabled={current.pending}
                onClick={props.onConfirm}
                type="button"
              >
                {current.pending ? "Switching sessions…" : "Switch sessions"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
