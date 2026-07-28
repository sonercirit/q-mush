import {
  createEffect,
  createMemo,
  createSignal,
  on,
  Show,
  untrack,
  type JSX,
} from "solid-js";
import type { AgentSessionToolName } from "../shared/agent-tools.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { SessionToolPicker } from "./session-tool-picker.tsx";

export function SessionToolUpdateEditor(props: {
  readonly detail: AgentSessionDetail;
  readonly disabled: boolean;
  readonly onApply: (
    tools: readonly AgentSessionToolName[],
    confirmedCacheDrop: boolean,
  ) => Promise<{ readonly warning: string | null; readonly updated: boolean }>;
}): JSX.Element {
  const [tools, setTools] = createSignal<readonly AgentSessionToolName[]>(
    untrack(() => props.detail.tools),
  );
  const [warning, setWarning] = createSignal<string | null>(null);
  const [applying, setApplying] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const toolRevision = createMemo(() => props.detail.tools.join("\n"));
  createEffect(
    on(toolRevision, () => {
      setTools(props.detail.tools);
      setWarning(null);
    }),
  );
  const apply = async (confirmedCacheDrop: boolean): Promise<void> => {
    setApplying(true);
    try {
      const outcome = await props.onApply(tools(), confirmedCacheDrop);
      setWarning(outcome.warning);
    } finally {
      setApplying(false);
    }
  };

  return (
    <section class="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h4 class="text-sm font-semibold text-slate-200">Session tool access</h4>
      <p class="mt-1 text-xs leading-5 text-slate-500">
        Changes fence the current execution generation. Newly enabled tools
        start on the next turn; removed tools cannot pass the execution gate.
      </p>
      <div class="mt-4">
        <SessionToolPicker
          disabled={props.disabled || applying()}
          onChange={setTools}
          onExpandedChange={setExpanded}
          tools={tools()}
        />
      </div>
      <Show when={warning()}>
        {(message) => (
          <div
            class="mt-4 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100"
            role="alert"
          >
            <p>{message()}</p>
            <button
              class="mt-3 rounded-lg bg-amber-200 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50"
              disabled={applying()}
              onClick={() => void apply(true)}
              type="button"
            >
              Apply anyway
            </button>
          </div>
        )}
      </Show>
      <Show when={expanded()}>
        <button
          class="mt-4 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50"
          disabled={props.disabled || applying()}
          onClick={() => void apply(false)}
          type="button"
        >
          {applying() ? "Applying…" : "Update tool access"}
        </button>
      </Show>
    </section>
  );
}
