import { Show, type JSX } from "solid-js";
import type {
  ToolStreamEntry,
  ToolStreamState,
} from "../shared/tool-stream.ts";
import { renderStructuredCode } from "./session-syntax.tsx";
import { renderToolResult } from "./session-tool-result.tsx";

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

function liveToolOutput(
  stream: ToolStreamEntry,
  channel: "stderr" | "stdout",
): JSX.Element {
  const content = stream[channel];
  const result = renderToolResult({
    arguments: stream.arguments,
    content: `${channel}:\n${content}`,
    name: toolStreamDisplayName(stream),
  });
  return (
    <Show when={content.length > 0}>
      <div class="mt-3">{result}</div>
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
  return (
    <>
      <p class="mt-2 text-xs font-semibold text-amber-200">
        {toolStateLabel(props.stream.state)}
      </p>
      <Show when={props.includeArguments && props.stream.arguments.length > 0}>
        <div class="mt-2">{renderStructuredCode(props.stream.arguments)}</div>
      </Show>
      {liveToolOutput(props.stream, "stdout")}
      {liveToolOutput(props.stream, "stderr")}
    </>
  );
}
