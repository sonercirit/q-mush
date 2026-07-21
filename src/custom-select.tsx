import { createElement, type JsxNode } from "./jsx.ts";

export interface CustomSelectOption {
  readonly description?: string;
  readonly detail?: string;
  readonly label: string;
  readonly value: string;
}

interface CustomSelectOptions {
  readonly disabled: boolean;
  readonly emptyLabel: string;
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly open: boolean;
  readonly options: readonly CustomSelectOption[];
  readonly required: boolean;
  readonly selectedValue: string;
}

const CONTROL_CLASSES =
  "mt-2 flex min-h-12 w-full min-w-0 items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-900 px-4 py-3 text-left text-sm text-white transition hover:border-white/20 focus:border-emerald-300/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

function selectedOption(
  options: readonly CustomSelectOption[],
  value: string,
): CustomSelectOption | undefined {
  return options.find((option) => option.value === value);
}

function optionContent(option: CustomSelectOption): JsxNode {
  return (
    <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
      <span className="min-w-0">
        <span className="block truncate">{option.label}</span>
        {option.description === undefined ? null : (
          <span className="mt-1 block whitespace-pre-line text-xs leading-5 text-slate-500">
            {option.description}
          </span>
        )}
      </span>
      {option.detail === undefined ? null : (
        <span className="shrink-0 text-xs text-slate-500">{option.detail}</span>
      )}
    </span>
  );
}

export function renderCustomSelect(options: CustomSelectOptions): JsxNode {
  const selected = selectedOption(options.options, options.selectedValue);
  const listboxId = `${options.id}-options`;

  return (
    <div
      className="relative"
      data-custom-select={options.name}
      data-custom-select-open={String(options.open)}
    >
      <label
        className="text-sm font-medium text-slate-200"
        id={`${options.id}-label`}
      >
        {options.label}
      </label>
      <input
        name={options.name}
        required={options.required}
        type="hidden"
        value={selected?.value ?? ""}
      />
      <button
        aria-controls={listboxId}
        aria-expanded={String(options.open)}
        aria-haspopup="listbox"
        aria-labelledby={`${options.id}-label ${options.id}-value`}
        className={CONTROL_CLASSES}
        data-action="toggle-session-select"
        data-select-name={options.name}
        disabled={options.disabled}
        id={options.id}
        type="button"
      >
        <span className="flex min-w-0 flex-1" id={`${options.id}-value`}>
          {selected === undefined
            ? options.emptyLabel
            : optionContent(selected)}
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-slate-500 transition ${options.open ? "rotate-180" : ""}`}
        >
          ▾
        </span>
      </button>
      {options.open ? (
        <ul
          aria-labelledby={`${options.id}-label`}
          className="absolute z-30 mt-2 max-h-72 w-full overflow-y-auto rounded-xl border border-white/15 bg-slate-950 p-1.5 shadow-2xl shadow-black/50"
          id={listboxId}
          role="listbox"
        >
          {options.options.map((option) => {
            const active = option.value === selected?.value;
            return (
              <li role="presentation">
                <button
                  aria-selected={String(active)}
                  className={`flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm transition ${active ? "bg-emerald-300/15 text-emerald-100" : "text-slate-300 hover:bg-white/[0.06] hover:text-white"}`}
                  data-action="choose-session-option"
                  data-option-value={option.value}
                  data-select-name={options.name}
                  role="option"
                  type="button"
                >
                  {optionContent(option)}
                  {active ? (
                    <span aria-hidden="true" className="ml-3 text-emerald-300">
                      ✓
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
