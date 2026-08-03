import type { JSX } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { renderMarkdown } from "./session-markdown.tsx";

export function CompactionRequestTranscriptMessage(props: {
  readonly message: AgentSessionMessage;
}): JSX.Element {
  return (
    <li
      class="min-w-0 rounded-xl border border-amber-300/20 bg-amber-300/10 p-3 sm:p-4"
      {...renderDebugBoundary(
        `message:${props.message.id}`,
        "Compaction request",
      )}
    >
      <p class="text-xs font-semibold tracking-wide text-amber-200 uppercase">
        Compaction request
      </p>
      <div class="mt-2">{renderMarkdown(props.message.content)}</div>
    </li>
  );
}
