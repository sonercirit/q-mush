import { For, Show, type JSX } from "solid-js";
import type { ToolSettings } from "../shared/tool-limits.ts";
import type {
  ToolStreamEntry,
  ToolStreamState,
} from "../shared/tool-stream.ts";
import { createNestedScrollRef } from "./nested-scroll.ts";
import { renderDebugBoundary } from "./render-debug.tsx";
import { renderToolArguments } from "./session-sleep-renderer.tsx";
import { renderLiveToolResult } from "./session-tool-result.tsx";

function toolStateLabel(state: ToolStreamState): string {
  switch (state) {
    case "preparing":
      return "Preparing";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "timed-out":
      return "Timed out";
  }
}

function LiveToolOutput(props: {
  readonly channel: "stderr" | "stdout";
  readonly stream: ToolStreamEntry;
}): JSX.Element {
  return (
    <Show when={props.stream[props.channel]}>
      {(content) => (
        <div class="mt-3">
          {renderLiveToolResult(
            toolStreamDisplayName(props.stream),
            `${props.channel}:\n${content()}`,
            props.stream.arguments,
          )}
        </div>
      )}
    </Show>
  );
}

export function LiveToolStreamList(props: {
  readonly settings: ToolSettings;
  readonly streams: readonly ToolStreamEntry[];
}): JSX.Element {
  return (
    <For each={props.streams}>
      {(stream) => <LiveToolStream settings={props.settings} stream={stream} />}
    </For>
  );
}

function toolStreamDisplayName(stream: ToolStreamEntry): string {
  return stream.name || "Preparing tool";
}

export function renderToolHeader(options: {
  readonly id: string | null;
  readonly kind: "Tool call" | "Tool result";
  readonly name: string;
}): JSX.Element {
  return (
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <p class="text-xs font-semibold tracking-wide text-cyan-300 uppercase">
        {`${options.kind} · ${options.name}`}
      </p>
      {options.id === null ? null : (
        <code class="break-all text-[0.65rem] text-slate-500">
          {options.id}
        </code>
      )}
    </div>
  );
}

function LiveToolStream(props: {
  readonly settings: ToolSettings;
  readonly stream: ToolStreamEntry;
}): JSX.Element {
  const name = (): string => toolStreamDisplayName(props.stream);
  const nestedScrollRef = createNestedScrollRef(
    () => `tool-stream:${props.stream.streamId}:${props.stream.callId}`,
  );
  return (
    <li
      class="rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-3"
      data-tool-stream-state={props.stream.state}
      ref={nestedScrollRef}
      {...renderDebugBoundary(
        `tool-stream:${props.stream.streamId}:${props.stream.callId}`,
        `Live tool: ${name()}`,
      )}
    >
      {renderToolHeader({
        id: props.stream.callId,
        kind: "Tool call",
        name: name(),
      })}
      <LiveToolActivityContent
        includeArguments={true}
        settings={props.settings}
        stream={props.stream}
      />
    </li>
  );
}

export function LiveToolActivityContent(props: {
  readonly includeArguments: boolean;
  readonly settings: ToolSettings;
  readonly stream: ToolStreamEntry;
}): JSX.Element {
  const stream = (): ToolStreamEntry => props.stream;
  return (
    <>
      <p class="mt-2 text-xs font-semibold text-amber-200">
        {toolStateLabel(stream().state)}
      </p>
      <Show when={props.includeArguments && stream().arguments.length > 0}>
        <div class="mt-2">
          {renderToolArguments(
            stream().name,
            stream().arguments,
            props.settings,
          )}
        </div>
      </Show>
      <LiveToolOutput channel="stdout" stream={stream()} />
      <LiveToolOutput channel="stderr" stream={stream()} />
    </>
  );
}
