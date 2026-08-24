import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import { isDispatchKey } from "../shared/dispatch.ts";
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

import type { InitialOption, OpenFocus } from "./custom-select-parts.tsx";
import {
  CONTROL_CLASSES,
  indexForValue,
  OPTION_CLASSES,
  OptionContent,
  PAGE_SIZE,
  PageControls,
  selectedPage,
} from "./custom-select-parts.tsx";
export function CustomSelect(props: CustomSelectProps): JSX.Element {
  const listboxId = (): string => `${props.id}-options`;
  const searchId = (): string => `${props.id}-search`;
  const searchStatusId = (): string => `${props.id}-search-status`;
  const paginationId = (): string => `${props.id}-pagination`;
  const selected = (): CustomSelectOption | undefined =>
    props.options.find((option) => option.value === props.selectedValue);
  const searchable = (): boolean => props.options.length > PAGE_SIZE;
  const [query, setQuery] = createSignal("");
  const [page, setPage] = createSignal(
    untrack(() => selectedPage(props.options, props.selectedValue)),
  );
  const [activeValue, setActiveValue] = createSignal(
    untrack(() => selected()?.value ?? props.options[0]?.value),
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
  const navigationHandlers = {
    ArrowDown: (): void => {
      moveActive(1);
    },
    ArrowUp: (): void => {
      moveActive(-1);
    },
    End: (): void => {
      setActiveIndex(filteredOptions().length - 1);
    },
    Home: (): void => {
      setActiveIndex(0);
    },
  } satisfies Record<string, () => void>;
  const isNavigationKey = (
    key: string,
  ): key is keyof typeof navigationHandlers =>
    isDispatchKey(navigationHandlers, key);
  const handleNavigationKey = (event: KeyboardEvent): boolean => {
    if (!isNavigationKey(event.key)) return false;
    navigationHandlers[event.key]();
    return true;
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
    const keyHandlers = {
      " ": (): void => {
        event.preventDefault();
        chooseActive();
      },
      Enter: (): void => {
        event.preventDefault();
        chooseActive();
      },
      Escape: (): void => {
        handleEscape(event);
      },
    } satisfies Record<string, () => void>;
    const isListAction = (key: string): key is keyof typeof keyHandlers =>
      isDispatchKey(keyHandlers, key);
    const handler = isListAction(event.key)
      ? keyHandlers[event.key]
      : undefined;
    if (handler !== undefined) {
      handler();
      return;
    }
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
  };
  const handleTriggerKey = (event: KeyboardEvent): void => {
    const openPositions = {
      ArrowDown: (): InitialOption => "selected",
      ArrowUp: (): InitialOption =>
        props.selectedValue.length === 0 ? "last" : "selected",
      End: (): InitialOption => "last",
      Home: (): InitialOption => "first",
    } satisfies Record<string, () => InitialOption>;
    const isOpenPositionKey = (
      key: string,
    ): key is keyof typeof openPositions => isDispatchKey(openPositions, key);
    const positionForKey = isOpenPositionKey(event.key)
      ? openPositions[event.key]
      : undefined;
    if (positionForKey === undefined) {
      if (event.key === "Enter" || event.key === " ") {
        if (event.detail === 0) toggleFromTrigger(event);
      } else if (event.key === "Escape" && props.open) {
        event.preventDefault();
        props.onToggle();
      }
      return;
    }
    const position = positionForKey();
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
