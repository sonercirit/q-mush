import { createSignal, Show, type JSX } from "solid-js";
import { setupDialogFocus } from "./dialog-focus.ts";

export function ConfirmationDialog(props: {
  readonly children: JSX.Element;
  readonly dataAttribute?: string;
  readonly description: JSX.Element;
  readonly id: string;
  readonly kicker: string;
  readonly onCancel: () => void;
  readonly open: boolean;
  readonly returnFocus: () => HTMLElement | undefined;
  readonly title: JSX.Element;
}): JSX.Element {
  const [surface, setSurface] = createSignal<HTMLElement>();
  function close(): void {
    props.onCancel();
  }
  function focusOrigin(): HTMLElement | undefined {
    return props.returnFocus();
  }
  setupDialogFocus({
    dialog: surface,
    onEscape: close,
    open: () => props.open,
    returnFocus: focusOrigin,
  });

  return (
    <Show when={props.open} keyed>
      <section
        aria-describedby={`${props.id}-description`}
        aria-labelledby={`${props.id}-title`}
        aria-modal="true"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
        data-context-token-cap-dialog={props.dataAttribute}
        onMouseDown={(event) => {
          const outside = event.target === event.currentTarget;
          if (outside) close();
        }}
        ref={setSurface}
        role="dialog"
        tabindex="-1"
      >
        <article class="w-full max-w-lg rounded-3xl border border-amber-300/20 bg-slate-900 p-5 shadow-2xl shadow-black/60 sm:p-7">
          <header>
            <span class="text-xs font-semibold tracking-wider text-amber-300 uppercase">
              {props.kicker}
            </span>
            <h3
              class="mt-2 text-xl font-semibold text-white"
              id={`${props.id}-title`}
            >
              {props.title}
            </h3>
          </header>
          <div
            class="mt-3 text-sm leading-6 text-slate-300"
            id={`${props.id}-description`}
          >
            {props.description}
          </div>
          <footer class="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <input
              class="min-h-11 cursor-pointer rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-white/20 hover:text-white"
              onClick={close}
              type="button"
              value="Cancel"
            />
            {props.children}
          </footer>
        </article>
      </section>
    </Show>
  );
}
