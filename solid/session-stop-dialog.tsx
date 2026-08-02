import { createSignal, Show, type JSX } from "solid-js";
import { setupDialogFocus } from "./dialog-focus.ts";

type SessionStopDialogProps = Readonly<{
  childCount: number | undefined;
  onCancel: () => void;
  onDecision: (cascade?: boolean) => void;
  returnFocus: () => HTMLElement | undefined;
  variant: "stop";
}>;

export const SessionStopDialog = (
  props: SessionStopDialogProps,
): JSX.Element => {
  const [dialog, setDialog] = createSignal<HTMLDivElement>();
  const open = (): boolean => props.childCount !== undefined;
  const hasChildren = (): boolean => (props.childCount ?? 0) > 0;
  const titleId = "session-stop-dialog-title";
  const descriptionId = "session-stop-dialog-description";

  const onEscape = (): void => {
    props.onCancel();
  };
  const returnFocus = (): HTMLElement | undefined => props.returnFocus();
  const focusState = { dialog, open };
  setupDialogFocus({
    ...focusState,
    onEscape,
    returnFocus,
  });

  return (
    <Show when={open()}>
      <div
        aria-describedby={descriptionId}
        data-stop-session-dialog={props.variant}
        aria-labelledby={titleId}
        aria-modal="true"
        class="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4 backdrop-blur-sm"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) props.onCancel();
        }}
        ref={setDialog}
        role="dialog"
        tabindex="-1"
      >
        <div class="w-full max-w-lg rounded-3xl border border-rose-300/20 bg-slate-900 p-5 shadow-2xl shadow-black/60 sm:p-7">
          <p class="text-xs font-semibold tracking-wider text-rose-300 uppercase">
            Stop session
          </p>
          <h3 class="mt-2 text-xl font-semibold text-white" id={titleId}>
            {hasChildren()
              ? `Also stop its ${String(props.childCount)} child ${props.childCount === 1 ? "session" : "sessions"}?`
              : "Stop this session?"}
          </h3>
          <p class="mt-3 text-sm leading-6 text-slate-300" id={descriptionId}>
            {hasChildren()
              ? "The parent session will stop immediately. Choose whether its child sessions should stop too."
              : "The session will stop immediately and its in-flight work will be lost."}
          </p>
          <div class="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              class="min-h-11 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-white/20 hover:text-white"
              onClick={() => {
                props.onCancel();
              }}
              type="button"
            >
              Cancel
            </button>
            <Show when={hasChildren()}>
              <button
                class="min-h-11 rounded-xl border border-rose-300/30 bg-rose-300/10 px-4 py-2.5 text-sm font-semibold text-rose-100 transition hover:border-rose-200/50 hover:bg-rose-300/15"
                onClick={() => {
                  props.onDecision(false);
                }}
                type="button"
              >
                Stop only this session
              </button>
            </Show>
            <button
              class="min-h-11 rounded-xl bg-rose-300 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-rose-200"
              onClick={() => {
                if (hasChildren()) props.onDecision(true);
                else props.onDecision();
              }}
              type="button"
            >
              {hasChildren() ? "Stop session and children" : "Stop"}
            </button>
          </div>
          <span aria-hidden="true" />
        </div>
      </div>
    </Show>
  );
};
