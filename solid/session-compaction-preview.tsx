import { Show, type JSX } from "solid-js";
import type { CompactionPreview } from "./session-compaction-state.ts";
import { renderMarkdown } from "./session-markdown.tsx";

function PreviewSection(props: {
  readonly content: string;
  readonly label: string;
  readonly truncated: boolean;
}): JSX.Element {
  return (
    <section aria-label={props.label} class="mt-3">
      <h5 class="text-xs font-semibold tracking-wide text-violet-200 uppercase">
        {props.label}
      </h5>
      <Show
        fallback={
          <p class="mt-2 text-sm text-slate-500">Waiting for output…</p>
        }
        when={props.content.length > 0}
      >
        <div class="mt-2">{renderMarkdown(props.content)}</div>
      </Show>
      <Show when={props.truncated}>
        <p class="mt-2 text-xs text-amber-200">
          Earlier preview output was truncated.
        </p>
      </Show>
    </section>
  );
}

export function CompactionPreviewCard(props: {
  readonly preview: CompactionPreview;
}): JSX.Element {
  return (
    <li
      aria-label="Compacting conversation"
      aria-live="off"
      aria-roledescription="temporary progress preview"
      class="rounded-xl border border-violet-300/20 bg-violet-300/10 p-4"
      data-compaction-preview={props.preview.operationId}
      role="status"
    >
      <div class="flex items-center gap-2">
        <span
          aria-hidden="true"
          class="h-2 w-2 animate-pulse rounded-full bg-violet-300"
        />
        <h4 class="text-sm font-semibold text-violet-100">
          Compacting conversation
        </h4>
      </div>
      <p class="mt-1 text-xs text-slate-400">
        Temporary preview. It is not part of the transcript.
      </p>
      <PreviewSection
        content={props.preview.summary}
        label="Summary preview"
        truncated={props.preview.summaryTruncated}
      />
      <PreviewSection
        content={props.preview.reasoning}
        label="Compaction reasoning"
        truncated={props.preview.reasoningTruncated}
      />
    </li>
  );
}
