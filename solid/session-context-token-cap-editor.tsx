import { createEffect, createSignal, type JSX } from "solid-js";
import {
  contextTokenCapValidationError,
  parseContextTokenCapInput,
} from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SessionContextTokenCapDialog } from "./session-context-token-cap-dialog.tsx";
import { SessionEditorError } from "./session-editor-client.tsx";
import { sessionMutationError } from "./session-mutations.ts";

export interface ContextTokenCapEditorProps {
  readonly detail: AgentSessionDetail;
  readonly disabled: boolean;
  readonly onApply: (
    cap: number | null,
    compactIfExceeded: boolean,
  ) => Promise<void>;
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
  const [pendingCap, setPendingCap] = createSignal<number>();
  const [trigger, setTrigger] = createSignal<HTMLElement>();
  const apply = async (
    cap: number | null,
    compactIfExceeded: boolean,
  ): Promise<void> => {
    try {
      await props.onApply(cap, compactIfExceeded);
    } catch (error) {
      setError(sessionMutationError(error, "change the context token cap"));
    }
  };
  const submit = (): void => {
    const cap = parseContextTokenCapInput(value());
    const message =
      cap === undefined
        ? "Context token cap must be a positive integer."
        : contextTokenCapValidationError(cap, props.detail.modelContextTokens);
    setError(message);
    if (message !== undefined || cap === undefined) return;
    if (
      cap !== null &&
      props.detail.autoCompact &&
      props.detail.currentContextTokens > cap
    ) {
      const activeElement = document.activeElement;
      setTrigger(
        activeElement instanceof HTMLElement ? activeElement : undefined,
      );
      setPendingCap(cap);
      return;
    }
    void apply(cap, false);
  };

  return (
    <>
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
        <SessionEditorError message={error()} />
      </form>
      <SessionContextTokenCapDialog
        cap={pendingCap()}
        onCancel={() => {
          setPendingCap(undefined);
        }}
        onConfirm={(cap) => {
          setPendingCap(undefined);
          void apply(cap, true);
        }}
        returnFocus={trigger}
      />
    </>
  );
}
