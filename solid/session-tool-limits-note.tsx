import { Show, type Accessor, type JSX } from "solid-js";
import {
  formatToolLimitsStatement,
  type ToolSettings,
} from "../shared/tool-limits.ts";

export function SessionToolLimitsHeader(props: {
  readonly settings: Accessor<ToolSettings | undefined>;
}): JSX.Element {
  return (
    <>
      <p class="text-sm font-medium text-emerald-300">
        First-party agent runtime
      </p>
      <h2
        class="mt-2 text-2xl font-semibold text-white"
        id="agent-sessions-title"
      >
        New agent session
      </h2>
      <p class="mt-3 max-w-3xl leading-7 text-slate-400">
        Start and steer coding sessions on your connected computers. Q Mush owns
        the model loop and runner tools end to end.
      </p>
      <Show
        fallback={
          <p
            class="mt-4 text-xs leading-5 text-amber-200"
            data-tool-limits-unavailable="true"
          >
            Current global tool limits are unavailable. Reload them before
            starting a session.
          </p>
        }
        when={props.settings()}
      >
        {(settings) => (
          <p
            class="mt-4 text-xs leading-5 text-slate-500"
            data-tool-limits-note="true"
          >
            {formatToolLimitsStatement(settings())}
          </p>
        )}
      </Show>
    </>
  );
}
