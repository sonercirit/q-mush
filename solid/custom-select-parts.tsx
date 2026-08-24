import { Show, type JSX } from "solid-js";
import type { CustomSelectOption } from "./custom-select.tsx";
export const PAGE_SIZE = 10;
export const CONTROL_CLASSES =
  "mt-2 flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-left text-sm text-white transition hover:border-white/20 focus:border-emerald-300/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
export const OPTION_CLASSES =
  "flex min-h-11 w-full min-w-0 items-center rounded-lg px-3 py-2.5 text-left text-sm transition";
export const PAGE_BUTTON_CLASSES =
  "min-h-10 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40";

export type InitialOption = "first" | "last" | "selected";
export type OpenFocus = "listbox" | "search";

export function indexForValue(
  options: readonly CustomSelectOption[],
  value: string | undefined,
): number {
  return options.findIndex((option) => option.value === value);
}

export function selectedPage(
  options: readonly CustomSelectOption[],
  selectedValue: string,
): number {
  return Math.max(
    0,
    Math.floor(indexForValue(options, selectedValue) / PAGE_SIZE),
  );
}

export function OptionContent(props: {
  readonly option: CustomSelectOption;
}): JSX.Element {
  return (
    <span class="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-3">
      <span class="min-w-0 flex-1">
        <span class="path-wrap block min-w-0 break-words">
          {props.option.label}
        </span>
        <Show when={props.option.description}>
          {(description) => (
            <span class="path-wrap mt-1 block whitespace-pre-line text-xs leading-5 text-slate-500">
              {description()}
            </span>
          )}
        </Show>
      </span>
      <Show when={props.option.detail}>
        {(detail) => (
          <span class="path-wrap text-xs text-slate-500 sm:shrink-0 sm:text-right">
            {detail()}
          </span>
        )}
      </Show>
    </span>
  );
}

export function PageControls(props: {
  readonly currentPage: number;
  readonly filteredCount: number;
  readonly label: string;
  readonly listboxId: string;
  readonly name: string;
  readonly onChange: (page: number) => void;
  readonly pageCount: number;
  readonly paginationId: string;
  readonly searching: boolean;
}): JSX.Element {
  const end = (): number =>
    Math.min((props.currentPage + 1) * PAGE_SIZE, props.filteredCount);
  return (
    <Show when={props.pageCount > 1}>
      <div
        class="flex flex-col gap-2 border-t border-white/10 p-2 sm:flex-row sm:items-center sm:justify-between"
        data-custom-select-page={props.name}
        id={props.paginationId}
      >
        <p aria-live="polite" class="px-1 text-xs text-slate-500">
          {props.currentPage * PAGE_SIZE + 1}–{end()} of {props.filteredCount}{" "}
          {props.searching ? "results" : "options"}
          <span class="sr-only">, </span>
          <span class="ml-1 whitespace-nowrap">
            Page {props.currentPage + 1} of {props.pageCount}
          </span>
        </p>
        <div class="grid grid-cols-2 gap-2">
          <button
            aria-controls={props.listboxId}
            aria-label={`Previous page of ${props.label}`}
            class={PAGE_BUTTON_CLASSES}
            data-custom-select-previous={props.name}
            disabled={props.currentPage === 0}
            onClick={() => {
              props.onChange(props.currentPage - 1);
            }}
            type="button"
          >
            Previous
          </button>
          <button
            aria-controls={props.listboxId}
            aria-label={`Next page of ${props.label}`}
            class={PAGE_BUTTON_CLASSES}
            data-custom-select-next={props.name}
            disabled={props.currentPage === props.pageCount - 1}
            onClick={() => {
              props.onChange(props.currentPage + 1);
            }}
            type="button"
          >
            Next
          </button>
        </div>
      </div>
    </Show>
  );
}
