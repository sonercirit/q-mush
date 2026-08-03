import { Show, type JSX } from "solid-js";
import type { AgentTokenUsageSummary } from "../shared/session-token-usage.ts";
import type { SessionController } from "./session-controller.ts";
import { SessionUsage } from "./session-usage-view.tsx";

export function SessionHistoryControls(props: {
  readonly controller: SessionController;
  readonly tokenUsage?: AgentTokenUsageSummary | undefined;
}): JSX.Element {
  const history = () => props.controller.view().history;
  const canGoOlder = (): boolean => {
    const current = history();
    return current.page === undefined
      ? props.controller.view().detail?.hasOlderSegments === true
      : current.canGoOlder;
  };
  const label = (): string => {
    const current = history();
    if (current.loading) {
      return "Loading history…";
    }
    const page = current.page;
    return page === undefined
      ? "Newest segment"
      : `Historical segment ${String(page.segment + 1)} of ${String(page.currentSegment)}`;
  };
  return (
    <Show
      when={
        props.controller.view().detail?.hasOlderSegments === true ||
        history().page !== undefined
      }
    >
      <nav
        aria-label="Transcript history pagination"
        class="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-slate-950/60 p-3"
        data-session-history-controls="true"
      >
        <button
          class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={history().loading || !canGoOlder()}
          onClick={() => {
            void props.controller.olderHistory();
          }}
          type="button"
        >
          Older
        </button>
        <span class="text-center text-xs text-slate-400">
          <span class="block">{label()}</span>
          <SessionUsage kind="segment" usage={props.tokenUsage} />
        </span>
        <button
          class="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-slate-300 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={history().loading || history().page === undefined}
          onClick={() => {
            void props.controller.newerHistory();
          }}
          type="button"
        >
          Newer
        </button>
      </nav>
      <Show when={history().error}>
        {(error) => (
          <p class="mt-2 text-xs text-rose-200" role="alert">
            {error()}
          </p>
        )}
      </Show>
    </Show>
  );
}
