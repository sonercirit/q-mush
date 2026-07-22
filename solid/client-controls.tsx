import { type JSX } from "solid-js";

const REMOVE_BUTTON_CLASSES =
  "shrink-0 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300";

interface ItemActionOptions {
  readonly action: string;
  readonly dataAttribute: string;
  readonly id: string;
  readonly pending: boolean;
}

function renderItemAction(
  options: ItemActionOptions,
  classes: string,
  idleLabel: string,
  pendingLabel: string,
): JSX.Element {
  return (
    <button
      class={classes}
      data-action={options.action}
      disabled={options.pending}
      type="button"
      {...{ [options.dataAttribute]: options.id }}
    >
      {options.pending ? pendingLabel : idleLabel}
    </button>
  );
}

export function renderDefaultControl(
  options: ItemActionOptions & { readonly isDefault: boolean },
): JSX.Element {
  if (options.isDefault) {
    return (
      <span class="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-200">
        Default
      </span>
    );
  }

  return renderItemAction(
    options,
    "rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-60",
    "Make default",
    "Setting…",
  );
}

export function renderRemovalButton(options: ItemActionOptions): JSX.Element {
  return renderItemAction(
    options,
    REMOVE_BUTTON_CLASSES,
    "Remove",
    "Removing…",
  );
}

export function renderRetryError(
  error: string | undefined,
  retryAction: string,
): JSX.Element {
  return error === undefined ? null : (
    <div
      class="mt-5 flex flex-col gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <p>{error}</p>
      <button
        class="shrink-0 font-semibold underline underline-offset-4"
        data-action={retryAction}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}
