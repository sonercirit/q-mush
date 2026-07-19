import { createElement, type JsxNode } from "./jsx.ts";

const REMOVE_BUTTON_CLASSES =
  "shrink-0 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300";

export function renderRemovalButton(options: {
  readonly action: string;
  readonly dataAttribute: string;
  readonly id: string;
  readonly pending: boolean;
}): JsxNode {
  return createElement(
    "button",
    {
      className: REMOVE_BUTTON_CLASSES,
      "data-action": options.action,
      [options.dataAttribute]: options.id,
      disabled: options.pending,
      type: "button",
    },
    options.pending ? "Removing…" : "Remove",
  );
}

export function renderRetryError(
  error: string | undefined,
  retryAction: string,
): JsxNode {
  return error === undefined ? null : (
    <div
      className="mt-5 flex flex-col gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <p>{error}</p>
      <button
        className="shrink-0 font-semibold underline underline-offset-4"
        data-action={retryAction}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}
