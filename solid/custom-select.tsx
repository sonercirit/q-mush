import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
  type JSX,
} from "solid-js";
import { normalizeSearchText } from "../shared/search.ts";

export interface CustomSelectOption {
  readonly description?: string;
  readonly detail?: string;
  readonly label: string;
  readonly value: string;
}

export interface CustomSelectProps {
  readonly disabled: boolean;
  readonly emptyLabel: string;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly onChoose: (value: string) => void;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly options: readonly CustomSelectOption[];
  readonly required: boolean;
  readonly selectedValue: string;
}

const PAGE_SIZE = 10;
const CONTROL_CLASSES =
  "mt-2 flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-left text-sm text-white transition hover:border-white/20 focus:border-emerald-300/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";
const OPTION_CLASSES =
  "flex min-h-11 w-full min-w-0 items-center rounded-lg px-3 py-2.5 text-left text-sm transition";
const PAGE_BUTTON_CLASSES =
  "min-h-10 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-40";

type InitialOption = "first" | "last" | "selected";
type OpenFocus = "listbox" | "search";

function indexForValue(
  options: readonly CustomSelectOption[],
  value: string | undefined,
): number {
  return options.findIndex((option) => option.value === value);
}

function selectedPage(props: CustomSelectProps): number {
  return Math.max(
    0,
    Math.floor(indexForValue(props.options, props.selectedValue) / PAGE_SIZE),
  );
}

function OptionContent(props: {
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

function PageControls(props: {
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

export function CustomSelect(props: CustomSelectProps): JSX.Element {
  const listboxId = (): string => `${props.id}-options`;
  const searchId = (): string => `${props.id}-search`;
  const searchStatusId = (): string => `${props.id}-search-status`;
  const paginationId = (): string => `${props.id}-pagination`;
  const selected = (): CustomSelectOption | undefined =>
    props.options.find((option) => option.value === props.selectedValue);
  const searchable = (): boolean => props.options.length > PAGE_SIZE;
  const [query, setQuery] = createSignal("");
  const [page, setPage] = createSignal(selectedPage(props));
  const [activeValue, setActiveValue] = createSignal(
    selected()?.value ?? props.options[0]?.value,
  );
  const [trigger, setTrigger] = createSignal<HTMLButtonElement>();
  const [searchInput, setSearchInput] = createSignal<HTMLInputElement>();
  const [listbox, setListbox] = createSignal<HTMLUListElement>();
  const filteredOptions = createMemo(() => {
    const search = searchable() ? normalizeSearchText(query()) : "";
    if (search.length === 0) {
      return props.options;
    }
    return props.options.filter((option) =>
      [option.label, option.value, option.description, option.detail].some(
        (value) =>
          value !== undefined && normalizeSearchText(value).includes(search),
      ),
    );
  });
  const maximumPage = (): number =>
    Math.max(0, Math.ceil(filteredOptions().length / PAGE_SIZE) - 1);
  const currentPage = (): number => Math.min(page(), maximumPage());
  const pageOptions = (): readonly CustomSelectOption[] => {
    const start = currentPage() * PAGE_SIZE;
    return filteredOptions().slice(start, start + PAGE_SIZE);
  };
  const pageCount = (): number =>
    Math.ceil(filteredOptions().length / PAGE_SIZE);
  const activeOption = (): CustomSelectOption | undefined =>
    filteredOptions().find((option) => option.value === activeValue());
  const optionId = (option: CustomSelectOption): string =>
    `${props.id}-option-${encodeURIComponent(option.value)}`;
  const activeOptionId = (): string | undefined => {
    const option = activeOption();
    return option === undefined ? undefined : optionId(option);
  };
  let preparedOpening = false;
  let openFocus: OpenFocus = "listbox";

  const focusSoon = (element: () => HTMLElement | undefined): void => {
    queueMicrotask(() => {
      element()?.focus();
    });
  };
  const scrollActiveOption = (): void => {
    const id = activeOptionId();
    if (id !== undefined) {
      queueMicrotask(() => {
        document.getElementById(id)?.scrollIntoView({ block: "nearest" });
      });
    }
  };
  const setActiveIndex = (requestedIndex: number): void => {
    const available = filteredOptions();
    const index = Math.min(Math.max(requestedIndex, 0), available.length - 1);
    const option = available[index];
    setActiveValue(option?.value);
    if (option !== undefined) {
      setPage(Math.floor(index / PAGE_SIZE));
      scrollActiveOption();
    }
  };
  const activeIndex = (): number =>
    indexForValue(filteredOptions(), activeValue());
  const moveActive = (offset: -1 | 1): void => {
    const index = activeIndex();
    const fallback = offset === 1 ? 0 : filteredOptions().length - 1;
    setActiveIndex(index < 0 ? fallback : index + offset);
  };
  const requestedIndex = (position: InitialOption): number => {
    if (position === "first") {
      return 0;
    }
    if (position === "last") {
      return filteredOptions().length - 1;
    }
    return Math.max(0, indexForValue(filteredOptions(), props.selectedValue));
  };
  const resetForOpen = (position: InitialOption, focus: OpenFocus): void => {
    setQuery("");
    const index = requestedIndex(position);
    setActiveIndex(index);
    setPage(Math.floor(Math.max(index, 0) / PAGE_SIZE));
    openFocus = searchable() ? focus : "listbox";
  };
  const prepareOpen = (position: InitialOption, focus: OpenFocus): void => {
    preparedOpening = true;
    resetForOpen(position, focus);
    props.onToggle();
  };
  const closeAndFocusTrigger = (): void => {
    if (props.open) {
      props.onToggle();
    }
    focusSoon(trigger);
  };
  const choose = (value: string): void => {
    props.onChoose(value);
    focusSoon(trigger);
  };
  const optionClick: JSX.EventHandler<HTMLButtonElement, MouseEvent> = (
    event,
  ): void => {
    const value = event.currentTarget.dataset["optionValue"];
    if (value !== undefined) {
      choose(value);
    }
  };
  const updateSearch = (value: string): void => {
    setQuery(value);
    setPage(0);
    setActiveValue(filteredOptions()[0]?.value);
    scrollActiveOption();
  };
  const changePage = (nextPage: number): void => {
    const clamped = Math.min(Math.max(nextPage, 0), maximumPage());
    setPage(clamped);
    setActiveValue(filteredOptions()[clamped * PAGE_SIZE]?.value);
    scrollActiveOption();
  };
  const chooseActive = (): void => {
    const option = activeOption();
    if (option !== undefined) {
      choose(option.value);
    }
  };
  const handleNavigationKey = (event: KeyboardEvent): boolean => {
    switch (event.key) {
      case "ArrowDown":
        moveActive(1);
        return true;
      case "ArrowUp":
        moveActive(-1);
        return true;
      case "End":
        setActiveIndex(filteredOptions().length - 1);
        return true;
      case "Home":
        setActiveIndex(0);
        return true;
      default:
        return false;
    }
  };
  const preventHandledNavigation = (event: KeyboardEvent): boolean => {
    const handled = handleNavigationKey(event);
    if (handled) {
      event.preventDefault();
    }
    return handled;
  };
  const handleEscape = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    closeAndFocusTrigger();
  };
  const handleListNavigation = (event: KeyboardEvent): void => {
    if (preventHandledNavigation(event)) {
      return;
    }
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        chooseActive();
        break;
      case "Escape":
        handleEscape(event);
        break;
      default:
        if (
          searchable() &&
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          updateSearch(`${query()}${event.key}`);
          focusSoon(searchInput);
        }
    }
  };
  const handleTriggerKey = (event: KeyboardEvent): void => {
    let position: InitialOption | undefined;
    switch (event.key) {
      case "ArrowDown":
        position = "selected";
        break;
      case "ArrowUp":
        position = props.selectedValue.length === 0 ? "last" : "selected";
        break;
      case "End":
        position = "last";
        break;
      case "Home":
        position = "first";
        break;
      case "Enter":
      case " ":
        if (event.detail === 0) {
          toggleFromTrigger(event);
        }
        return;
      case "Escape":
        if (props.open) {
          event.preventDefault();
          props.onToggle();
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    if (props.open) {
      setActiveIndex(requestedIndex(position));
      focusSoon(listbox);
    } else {
      prepareOpen(position, "listbox");
    }
  };
  const handleSearchKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      chooseActive();
      return;
    }
    if (event.key === "Escape") {
      handleEscape(event);
      return;
    }
    preventHandledNavigation(event);
  };
  const toggleFromTrigger = (event?: Event): void => {
    event?.preventDefault();
    if (props.open) {
      props.onToggle();
    } else {
      prepareOpen("selected", "search");
    }
  };

  createEffect(() => {
    setPage((current) => Math.min(current, maximumPage()));
  });
  createEffect(() => {
    const available = filteredOptions();
    if (indexForValue(available, activeValue()) < 0) {
      setActiveValue(available[currentPage() * PAGE_SIZE]?.value);
    }
  });
  createEffect(
    on(
      [() => props.options, () => props.selectedValue],
      () => {
        if (!props.open) {
          return;
        }
        setQuery("");
        const index = Math.max(
          0,
          indexForValue(props.options, props.selectedValue),
        );
        setPage(Math.floor(index / PAGE_SIZE));
        setActiveValue(props.options[index]?.value);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      () => props.open,
      (open, wasOpen) => {
        if (open && !wasOpen) {
          if (!preparedOpening) {
            resetForOpen("selected", "search");
          }
          preparedOpening = false;
          focusSoon(openFocus === "search" ? searchInput : listbox);
        }
      },
    ),
  );

  return (
    <div
      class="relative"
      data-custom-select={props.name}
      data-custom-select-open={String(props.open)}
    >
      <label
        class="text-sm font-medium text-slate-200"
        id={`${props.id}-label`}
      >
        {props.label}
      </label>
      <input
        name={props.name}
        required={props.required}
        type="hidden"
        value={selected()?.value ?? ""}
      />
      <button
        aria-activedescendant={props.open ? activeOptionId() : undefined}
        aria-controls={listboxId()}
        aria-expanded={props.open}
        aria-haspopup="listbox"
        aria-labelledby={`${props.id}-label ${props.id}-value`}
        class={CONTROL_CLASSES}
        disabled={props.disabled}
        id={props.id}
        onClick={toggleFromTrigger}
        onKeyDown={handleTriggerKey}
        ref={setTrigger}
        type="button"
      >
        <span class="flex min-w-0 flex-1" id={`${props.id}-value`}>
          <Show fallback={props.emptyLabel} when={selected()}>
            {(option) => <OptionContent option={option()} />}
          </Show>
        </span>
        <span
          aria-hidden="true"
          class={`shrink-0 text-slate-500 transition ${props.open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      <Show when={props.open}>
        <div class="absolute right-0 left-0 z-30 mt-2 min-w-0 overflow-hidden rounded-xl border border-white/15 bg-slate-950 shadow-2xl shadow-black/50">
          <Show when={searchable()}>
            <div class="border-b border-white/10 p-2">
              <label class="sr-only" for={searchId()}>
                Search {props.label}
              </label>
              <input
                aria-activedescendant={activeOptionId()}
                aria-controls={listboxId()}
                aria-describedby={`${searchStatusId()} ${paginationId()}`}
                aria-expanded={props.open}
                aria-haspopup="listbox"
                aria-label={`Search ${props.label}`}
                autocomplete="off"
                class="min-h-11 w-full min-w-0 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-base text-white placeholder:text-slate-600 focus:border-emerald-300/50 focus:outline-none sm:text-sm"
                data-custom-select-search={props.name}
                id={searchId()}
                onInput={(event) => {
                  updateSearch(event.currentTarget.value);
                }}
                onKeyDown={handleSearchKey}
                placeholder="Search options…"
                ref={setSearchInput}
                role="combobox"
                spellcheck={false}
                type="search"
                value={query()}
              />
              <Show when={query().length > 0}>
                <p
                  aria-live="polite"
                  class={`px-1 pt-2 text-xs ${filteredOptions().length === 0 ? "text-amber-200" : "text-slate-500"}`}
                  id={searchStatusId()}
                  role="status"
                >
                  {filteredOptions().length === 0
                    ? `No options match “${query()}”`
                    : `${String(filteredOptions().length)} ${filteredOptions().length === 1 ? "result" : "results"}`}
                </p>
              </Show>
            </div>
          </Show>
          <ul
            aria-activedescendant={activeOptionId()}
            aria-labelledby={`${props.id}-label`}
            class="max-h-[min(18rem,50dvh)] min-w-0 overflow-y-auto overscroll-contain p-1.5 focus:outline-none"
            id={listboxId()}
            onKeyDown={handleListNavigation}
            ref={setListbox}
            role="listbox"
            tabindex="0"
          >
            <For each={pageOptions()}>
              {(option) => {
                const selectedOption = (): boolean =>
                  option.value === selected()?.value;
                const focused = (): boolean => option.value === activeValue();
                const position = (): number =>
                  indexForValue(filteredOptions(), option.value) + 1;
                return (
                  <li role="presentation">
                    <button
                      aria-posinset={position()}
                      aria-selected={selectedOption()}
                      aria-setsize={filteredOptions().length}
                      class={`${OPTION_CLASSES} ${selectedOption() ? "bg-emerald-300/15 text-emerald-100" : focused() ? "bg-white/[0.08] text-white" : "text-slate-300 hover:bg-white/[0.06] hover:text-white"}`}
                      data-option-active={String(focused())}
                      data-option-value={option.value}
                      id={optionId(option)}
                      onClick={optionClick}
                      onMouseMove={() => {
                        setActiveValue(option.value);
                      }}
                      role="option"
                      tabindex="-1"
                      type="button"
                    >
                      <OptionContent option={option} />
                      <Show when={selectedOption()}>
                        <span aria-hidden="true" class="ml-3 text-emerald-300">
                          ✓
                        </span>
                      </Show>
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
          <PageControls
            currentPage={currentPage()}
            filteredCount={filteredOptions().length}
            label={props.label}
            listboxId={listboxId()}
            name={props.name}
            onChange={changePage}
            pageCount={pageCount()}
            paginationId={paginationId()}
            searching={normalizeSearchText(query()).length > 0}
          />
        </div>
      </Show>
    </div>
  );
}
