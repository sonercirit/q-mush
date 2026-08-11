import { createMemo, Index, Show, type JSX } from "solid-js";
import type { AgentSessionMessage } from "../shared/session-model.ts";
import type { ToolStreamEntry } from "../shared/tool-stream.ts";

export type StreamedMessageRenderer = (
  message: () => AgentSessionMessage,
  liveToolStreams: () => readonly ToolStreamEntry[],
) => JSX.Element;

/**
 * Renders live streamed messages position-keyed so a delta updates the
 * existing message DOM instead of rebuilding it. Stream message IDs stay
 * stable across deltas; a row only re-creates when its id or role changes.
 */
export function StreamedMessageList(props: {
  readonly messages: readonly AgentSessionMessage[];
  readonly render: StreamedMessageRenderer;
  readonly toolStreams?: (messageId: string) => readonly ToolStreamEntry[];
}): JSX.Element {
  return (
    <Index each={props.messages}>
      {(message) => {
        const key = createMemo(() => `${message().id}:${message().role}`);
        const liveToolStreams = createMemo(
          () => props.toolStreams?.(message().id) ?? [],
        );
        return (
          <Show keyed when={key()}>
            {(activeKey) => {
              void activeKey;
              return props.render(message, liveToolStreams);
            }}
          </Show>
        );
      }}
    </Index>
  );
}
