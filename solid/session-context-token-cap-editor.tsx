import { createEffect, createSignal, type JSX } from "solid-js";
import {
  contextTokenCapValidationError,
  parseContextTokenCapInput,
} from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export interface ContextTokenCapEditorProps {
  readonly detail: AgentSessionDetail;
  readonly disabled: boolean;
  readonly onApply: (cap: number | null) => Promise<void>;
  readonly onWarning: (cap: number) => void;
}

export function SessionContextTokenCapEditor(
  props: ContextTokenCapEditorProps,
): JSX.Element {
  const [value, setValue] = createSignal("");
  createEffect(() => {
    setValue(
      props.detail.userContextTokenCap === null
        ? ""
        : String(props.detail.userContextTokenCap),
    );
  });
  const [error, setError] = createSignal<string>();
  const submit = (): void => {
    const cap = parseContextTokenCapInput(value());
    const message =
      cap === undefined
        ? "Context token cap must be a positive integer."
        : contextTokenCapValidationError(cap, props.detail.maxContextTokens);
    setError(message);
    if (message !== undefined || cap === undefined) return;
    if (cap !== null && props.detail.currentContextTokens > cap) {
      props.onWarning(cap);
      return;
    }
    void props.onApply(cap);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div class="flex flex-wrap items-end gap-3">
        <label class="min-w-52 flex-1 text-sm font-medium text-slate-200">
          Context token cap
          <input
            class="mt-2 min-h-10 w-full rounded-lg border border-white/10 bg-slate-950 px-3 text-white"
            disabled={props.disabled}
            id="session-detail-context-token-cap"
            min="1"
            onInput={(event) => {
              setValue(event.currentTarget.value);
              setError(undefined);
            }}
            placeholder="Use the model limit"
            step="1"
            type="number"
            value={value()}
          />
        </label>
        <button
          class="min-h-10 rounded-lg border border-cyan-300/20 px-3 text-xs font-semibold text-cyan-200 disabled:opacity-50"
          disabled={props.disabled}
          type="submit"
        >
          Save cap
        </button>
      </div>
      <p class="mt-1 text-xs text-slate-500">
        Leave blank to restore the model limit.
      </p>
      {error() === undefined ? null : (
        <p class="mt-2 text-sm text-rose-200" role="alert">
          {error()}
        </p>
      )}
    </form>
  );
}
