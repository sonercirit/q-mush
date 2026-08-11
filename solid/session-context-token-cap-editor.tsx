import { createEffect, createSignal, type JSX } from "solid-js";
import {
  contextTokenCapValidationError,
  parseContextTokenCapInput,
} from "../shared/session-context-limit.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SessionContextTokenCapDialog } from "./session-context-token-cap-dialog.tsx";
import {
  SessionEditorError,
  SessionEditorSection,
} from "./session-editor-client.tsx";
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
      <SessionEditorSection
        description={
          <>
            Cap the context tokens available to future turns. Leave blank to
            restore the model limit.
          </>
        }
        kind="cap"
        title="Context token cap"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div class="mt-4 flex flex-wrap items-center gap-3">
            <label class="min-w-52 flex-1">
              <span class="sr-only">Context token cap</span>
              <input
                class="min-h-10 w-full rounded-xl border border-white/10 bg-slate-900 px-4 text-sm text-white placeholder:text-slate-600 focus:border-cyan-300/50 focus:outline-none"
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
              class="min-h-10 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-100 disabled:opacity-50"
              disabled={props.disabled}
              type="submit"
            >
              Save cap
            </button>
          </div>
          <SessionEditorError message={error()} />
        </form>
      </SessionEditorSection>
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
