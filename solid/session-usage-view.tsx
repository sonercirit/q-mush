import { Show, type JSX } from "solid-js";
import type { AgentTokenUsageSummary } from "../shared/session-token-usage.ts";
import { sessionUsageText } from "./session-usage.ts";

export function SessionUsage(props: {
  readonly kind: "segment" | "session";
  readonly usage?: AgentTokenUsageSummary | undefined;
}): JSX.Element {
  return (
    <Show when={props.usage}>
      {(usage) => (
        <span
          class="mt-1 block text-xs text-slate-500"
          data-segment-usage={props.kind === "segment" ? "true" : undefined}
          data-session-usage={props.kind === "session" ? "true" : undefined}
        >
          {sessionUsageText(usage())}
        </span>
      )}
    </Show>
  );
}
