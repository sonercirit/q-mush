import { createSignal, Show, type JSX } from "solid-js";
import { setupDialogFocus } from "./dialog-focus.ts";
import { formatTokenCount } from "./session-context-client.tsx";

export function SessionContextTokenCapDialog(props: {
  readonly cap: number | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: (cap: number) => void;
  readonly returnFocus: () => HTMLElement | undefined;
}): JSX.Element {
  const [dialog, setDialog] = createSignal<HTMLDivElement>();
  const open = (): boolean => props.cap !== undefined;
  setupDialogFocus({
    dialog,
    onEscape: props.onCancel,
    open,
    returnFocus: props.returnFocus,
  });

  return (
    <Show when={props.cap}>
      {(cap) => (
        <div
          aria-describedby="session-context-cap-dialog-description"
          aria-labelledby="session-context-cap-dialog-title"
          aria-modal="true"
          class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
          data-context-token-cap-dialog="true"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) props.onCancel();
          }}
          ref={setDialog}
          role="dialog"
          tabindex="-1"
        >
          <div class="w-full max-w-lg rounded-3xl border border-amber-300/20 bg-slate-900 p-5 shadow-2xl shadow-black/60 sm:p-7">
            <p class="text-xs font-semibold tracking-wider text-amber-300 uppercase">
              Context limit exceeded
            </p>
            <h3
              class="mt-2 text-xl font-semibold text-white"
              id="session-context-cap-dialog-title"
            >
              Apply a {formatTokenCount(cap())} token cap?
            </h3>
            <p
              class="mt-3 text-sm leading-6 text-slate-300"
              id="session-context-cap-dialog-description"
            >
              Current context usage already exceeds this cap. Automatic
              compaction will trigger first when enabled.
            </p>
            <menu class="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-end">
              <button
                class="min-h-11 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300"
                onClick={props.onCancel}
                type="button"
              >
                Cancel
              </button>
              <button
                class="min-h-11 rounded-xl bg-amber-300 px-4 py-2.5 text-sm font-semibold text-slate-950"
                onClick={() => props.onConfirm(cap())}
                type="button"
              >
                Apply cap
              </button>
            </menu>
          </div>
        </div>
      )}
    </Show>
  );
}
