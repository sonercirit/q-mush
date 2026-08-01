import { Show, type JSX } from "solid-js";
import type {
  ToolStreamEntry,
  ToolStreamState,
} from "../shared/tool-stream.ts";
import { renderStructuredCode } from "./session-syntax.tsx";
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

export function toolStreamDisplayName(stream: ToolStreamEntry): string {
  return stream.name || "Preparing tool";
}

export function LiveToolActivityContent(props: {
  readonly includeArguments: boolean;
  readonly stream: ToolStreamEntry;
}): JSX.Element {
  const stream = (): ToolStreamEntry => props.stream;
  return (
    <>
      <p class="mt-2 text-xs font-semibold text-amber-200">
        {toolStateLabel(stream().state)}
      </p>
      <Show when={props.includeArguments && stream().arguments.length > 0}>
        <div class="mt-2">{renderStructuredCode(stream().arguments)}</div>
      </Show>
      <LiveToolOutput channel="stdout" stream={stream()} />
      <LiveToolOutput channel="stderr" stream={stream()} />
    </>
  );
}
