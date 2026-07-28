import { For, Show, type JSX } from "solid-js";

interface CollectionProps<Item> {
  readonly children: (item: Item) => JSX.Element;
  readonly empty: JSX.Element;
  readonly items: readonly Item[] | undefined;
  readonly listClass: string;
  readonly listProps?:
    Pick<JSX.HTMLAttributes<HTMLUListElement>, "onScroll" | "ref"> | undefined;
  readonly loading: JSX.Element;
  readonly trailing?: JSX.Element | undefined;
  readonly retry?: {
    readonly error: string | undefined;
    readonly onRetry: () => void;
  };
}

export interface RetryNoticeProps {
  readonly error: string | undefined;
  readonly onRetry: () => void;
  readonly retryLabel?: string;
}

export function RetryNotice(props: RetryNoticeProps): JSX.Element {
  return (
    <Show when={props.error}>
      {(error) => (
        <div
          class="mt-5 flex flex-col gap-3 rounded-2xl border border-rose-300/20 bg-rose-300/10 p-4 text-sm text-rose-100 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p class="path-wrap min-w-0 flex-1">{error()}</p>
          <button
            class="min-h-11 shrink-0 font-semibold underline underline-offset-4"
            type="button"
            onClick={props.onRetry}
          >
            {props.retryLabel ?? "Retry"}
          </button>
        </div>
      )}
    </Show>
  );
}

function CollectionContent<Item>(
  props: Pick<
    CollectionProps<Item>,
    "children" | "empty" | "items" | "listClass" | "listProps" | "trailing"
  >,
): JSX.Element {
  return (
    <Show when={props.items}>
      {(availableItems) => (
        <Show fallback={props.empty} when={availableItems().length > 0}>
          <ul class={props.listClass} {...props.listProps}>
            <For each={availableItems()}>{props.children}</For>
            {props.trailing}
          </ul>
        </Show>
      )}
    </Show>
  );
}

export function Collection<Item>(props: CollectionProps<Item>): JSX.Element {
  return (
    <Show
      fallback={
        <Show fallback={props.loading} when={props.retry?.error}>
          <RetryNotice
            error={props.retry?.error}
            onRetry={() => {
              props.retry?.onRetry();
            }}
          />
        </Show>
      }
      when={props.items !== undefined}
    >
      <Show when={props.retry}>
        {(availableRetry) => <RetryNotice {...availableRetry()} />}
      </Show>
      <CollectionContent
        empty={props.empty}
        items={props.items}
        listClass={props.listClass}
        listProps={props.listProps}
        trailing={props.trailing}
      >
        {props.children}
      </CollectionContent>
    </Show>
  );
}
