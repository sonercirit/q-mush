import { Show, type JSX } from "solid-js";

const REMOVE_BUTTON_CLASSES =
  "min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-rose-300/30 hover:text-rose-200 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-300";

interface ItemActionProps {
  readonly data?: Readonly<Record<string, number | string>>;
  readonly idleLabel: string;
  readonly onClick: () => void;
  readonly pending: boolean;
  readonly pendingLabel: string;
}

function ItemAction(
  props: ItemActionProps & { readonly class: string },
): JSX.Element {
  return (
    <button
      class={props.class}
      {...props.data}
      disabled={props.pending}
      onClick={() => {
        props.onClick();
      }}
      type="button"
    >
      {props.pending ? props.pendingLabel : props.idleLabel}
    </button>
  );
}

export function DefaultControl(
  props: ItemActionProps & { readonly isDefault: boolean },
): JSX.Element {
  return (
    <Show
      fallback={
        <ItemAction
          {...props}
          class="min-h-11 rounded-xl border border-white/10 px-4 py-2 text-sm font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-60"
        />
      }
      when={props.isDefault}
    >
      <span class="inline-flex min-h-11 items-center rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-200">
        Default
      </span>
    </Show>
  );
}

export function RemovalButton(
  props: Omit<ItemActionProps, "idleLabel" | "pendingLabel">,
): JSX.Element {
  return (
    <ItemAction
      {...props}
      class={REMOVE_BUTTON_CLASSES}
      idleLabel="Remove"
      pendingLabel="Removing…"
    />
  );
}
