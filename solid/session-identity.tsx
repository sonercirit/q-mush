import { Show, type JSX } from "solid-js";
import { clipboardCopyLabel, createClipboardCopy } from "./clipboard-copy.ts";

export function SessionIdentity(props: {
  readonly sessionId: string;
}): JSX.Element {
  const sessionId = (): string => props.sessionId;
  const clipboard = createClipboardCopy(sessionId);
  const idle = (): boolean => clipboard.state() === "idle";

  return (
    <div
      aria-label="Session identity"
      class="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500"
      data-session-identity="true"
      role="group"
    >
      <span class="shrink-0">Session ID:</span>
      <code
        class="path-wrap min-w-0 flex-1 select-text text-cyan-200 [overflow-wrap:anywhere]"
        data-session-id-value="true"
      >
        {sessionId()}
      </code>
      <button
        aria-label="Copy session ID"
        class="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[0.65rem] font-semibold text-slate-300 transition hover:border-emerald-300/30 hover:text-emerald-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
        data-copy-session-id="true"
        onClick={() => void clipboard.copy()}
        type="button"
      >
        {clipboardCopyLabel(clipboard.state(), "Copy ID")}
      </button>
      <span aria-live="polite" class="sr-only" role="status">
        <Show when={!idle()}>{clipboardCopyLabel(clipboard.state(), "")}</Show>
      </span>
    </div>
  );
}
