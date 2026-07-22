import { For, Show, type JSX } from "solid-js";

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

const CONTROL_CLASSES =
  "mt-2 flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-left text-sm text-white transition hover:border-white/20 focus:border-emerald-300/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

function selectedOption(
  props: CustomSelectProps,
): CustomSelectOption | undefined {
  return props.options.find((option) => option.value === props.selectedValue);
}

function OptionContent(props: {
  readonly option: CustomSelectOption;
}): JSX.Element {
  return (
    <span class="flex min-w-0 flex-1 items-start justify-between gap-3">
      <span class="min-w-0">
        <span class="block truncate">{props.option.label}</span>
        <Show when={props.option.description}>
          {(description) => (
            <span class="mt-1 block whitespace-pre-line text-xs leading-5 text-slate-500">
              {description()}
            </span>
          )}
        </Show>
      </span>
      <Show when={props.option.detail}>
        {(detail) => (
          <span class="shrink-0 text-xs text-slate-500">{detail()}</span>
        )}
      </Show>
    </span>
  );
}

export function CustomSelect(props: CustomSelectProps): JSX.Element {
  const listboxId = (): string => `${props.id}-options`;
  const selected = (): CustomSelectOption | undefined => selectedOption(props);

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
        aria-controls={listboxId()}
        aria-expanded={props.open}
        aria-haspopup="listbox"
        aria-labelledby={`${props.id}-label ${props.id}-value`}
        class={CONTROL_CLASSES}
        disabled={props.disabled}
        id={props.id}
        onClick={props.onToggle}
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
        <ul
          aria-labelledby={`${props.id}-label`}
          class="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-white/15 bg-slate-950 p-1.5 shadow-2xl shadow-black/50"
          id={listboxId()}
          role="listbox"
        >
          <For each={props.options}>
            {(option) => {
              const active = (): boolean => option.value === selected()?.value;
              return (
                <li role="presentation">
                  <button
                    aria-selected={active()}
                    class={`flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm transition ${active() ? "bg-emerald-300/15 text-emerald-100" : "text-slate-300 hover:bg-white/[0.06] hover:text-white"}`}
                    data-option-value={option.value}
                    onClick={() => {
                      props.onChoose(option.value);
                    }}
                    role="option"
                    type="button"
                  >
                    <OptionContent option={option} />
                    <Show when={active()}>
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
      </Show>
    </div>
  );
}
