import { For, Show, type JSX } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";

export function ActiveStepAnchor(props: {
  readonly messages: readonly AgentSessionMessage[];
  readonly renderMessage: (message: AgentSessionMessage) => JSX.Element;
  readonly timing: JSX.Element;
}): JSX.Element {
  return (
    <li
      aria-busy="true"
      class="contents"
      data-active-step="running"
      data-step-anchor
    >
      <Show
        fallback={
          <div class="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-3 sm:mr-8 sm:p-4">
            <p class="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
              Agent
              <span class="flex items-center gap-1.5 text-emerald-200">
                <span class="size-2 animate-pulse rounded-full bg-emerald-300" />
                Running
              </span>
            </p>
          </div>
        }
        when={props.messages.length > 0}
      >
        <For each={props.messages}>{props.renderMessage}</For>
      </Show>
      <div class="mt-3">{props.timing}</div>
    </li>
  );
}
