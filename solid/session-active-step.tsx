import { For, Show, type JSX } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";
import { LiveToolStream } from "./session-live-tool-activity.tsx";
import {
  StreamedMessageList,
  type StreamedMessageRenderer,
} from "./session-streamed-messages.tsx";

function RunningAgentBlock(props: {
  readonly toolStreams: readonly ToolStreamEntry[];
}): JSX.Element {
  return (
    <div class="min-w-0 rounded-2xl border border-white/10 bg-white/[0.04] p-3 sm:mr-8 sm:p-4">
      <p class="flex items-center gap-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
        Agent
        <span class="flex items-center gap-1.5 text-emerald-200">
          <span class="size-2 animate-pulse rounded-full bg-emerald-300" />
          Running
        </span>
      </p>
      <ul class="mt-3 space-y-2">
        <For each={props.toolStreams}>
          {(stream) => <LiveToolStream stream={stream} />}
        </For>
      </ul>
    </div>
  );
}

export function ActiveStepAnchor(props: {
  readonly messages: readonly AgentSessionMessage[];
  readonly render: StreamedMessageRenderer;
  readonly timing: JSX.Element;
  readonly toolStreams: readonly ToolStreamEntry[];
}): JSX.Element {
  const toolStreamHostId = (): string | undefined =>
    props.messages.findLast((message) => message.role === "assistant")?.id;
  const hasContent = (): boolean =>
    props.messages.length > 0 || props.toolStreams.length > 0;
  return (
    <Show
      fallback={
        <li class="contents" data-step-anchor>
          <div class="mt-3">{props.timing}</div>
        </li>
      }
      when={hasContent()}
    >
      <li
        aria-busy="true"
        class="contents"
        data-active-step="running"
        data-step-anchor
      >
        <StreamedMessageList
          messages={props.messages}
          render={props.render}
          toolStreams={(messageId) =>
            messageId === toolStreamHostId() ? props.toolStreams : []
          }
        />
        <Show
          when={
            props.toolStreams.length > 0 && toolStreamHostId() === undefined
          }
        >
          <RunningAgentBlock toolStreams={props.toolStreams} />
        </Show>
        <div class="mt-3">{props.timing}</div>
      </li>
    </Show>
  );
}
