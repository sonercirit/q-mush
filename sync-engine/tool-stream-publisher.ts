import {
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  type ToolStreamChannel,
  type ToolStreamState,
  type ToolStreamTerminalState,
} from "../shared/tool-stream.ts";
import { truncateUtf8 } from "../shared/utf8.ts";
import type { ProviderToolCallDelta } from "./provider-stream.ts";
import type { RealtimeHub } from "./realtime-hub.ts";

const TRUNCATED_MARKER = "\n[stream truncated]";
const TRUNCATED_MARKER_BYTES = Buffer.byteLength(TRUNCATED_MARKER);
const MAXIMUM_TOOL_STREAM_BODY_BYTES =
  MAXIMUM_TOOL_STREAM_FIELD_BYTES - TRUNCATED_MARKER_BYTES;

interface ActiveToolStream {
  argumentBytes: number;
  callId: string;
  index: number;
  name: string;
  nameBytes: number;
  sequence: number;
  stderrBytes: number;
  stdoutBytes: number;
  readonly streamId: string;
  readonly truncated: Set<ToolStreamChannel>;
}

function errorState(error: unknown): ToolStreamTerminalState {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "canceled";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed[ -]?out/iu.test(message) ? "timed-out" : "failed";
}

interface QueuedToolStreamDelta {
  readonly callId: string;
  readonly delta: {
    channel?: ToolStreamChannel;
    content?: string;
    previousCallId?: string;
    state?: ToolStreamState;
  };
  readonly index: number;
  readonly sequence: number;
  readonly streamId: string;
}

function bytesKey(
  channel: ToolStreamChannel,
): "argumentBytes" | "nameBytes" | "stderrBytes" | "stdoutBytes" {
  switch (channel) {
    case "arguments":
      return "argumentBytes";
    case "name":
      return "nameBytes";
    case "stderr":
      return "stderrBytes";
    case "stdout":
      return "stdoutBytes";
  }
}

export class ToolStreamPublisher {
  readonly #callsById = new Map<string, ActiveToolStream>();
  readonly #callsByIndex = new Map<number, ActiveToolStream>();
  readonly #hub: RealtimeHub | undefined;
  readonly #queued: QueuedToolStreamDelta[] = [];
  readonly #sessionId: string;
  readonly #userId: string;
  #closed = false;
  #flushScheduled = false;
  #nextIndex = 0;
  #streamId: string;

  constructor(options: {
    readonly hub: RealtimeHub | undefined;
    readonly sessionId: string;
    readonly streamId: string;
    readonly userId: string;
  }) {
    this.#hub = options.hub;
    this.#sessionId = options.sessionId;
    this.#streamId = options.streamId;
    this.#userId = options.userId;
  }

  startTurn(streamId: string): void {
    this.#begin(streamId, false);
  }

  reset(streamId: string): void {
    this.#begin(streamId, true);
  }

  #begin(streamId: string, flush: boolean): void {
    if (this.#closed) {
      return;
    }
    this.#clear("canceled");
    if (flush) {
      this.#flush();
    }
    this.#streamId = streamId;
    this.#nextIndex = 0;
  }

  #clear(state: ToolStreamState): void {
    for (const call of this.#callsById.values()) {
      this.#state(call, state);
    }
    this.#callsByIndex.clear();
    this.#callsById.clear();
  }

  #createCall(callId: string, index: number, name: string): ActiveToolStream {
    const boundedName = truncateUtf8(name, MAXIMUM_TOOL_STREAM_BODY_BYTES);
    return {
      argumentBytes: 0,
      callId,
      index,
      name: boundedName,
      nameBytes: Buffer.byteLength(boundedName),
      sequence: 0,
      stderrBytes: 0,
      stdoutBytes: 0,
      streamId: this.#streamId,
      truncated: new Set(),
    };
  }

  #rename(call: ActiveToolStream, callId: string): void {
    const previousId = call.callId;
    this.#callsById.delete(previousId);
    call.callId = callId;
    this.#callsById.set(callId, call);
    this.#publish(call, { previousCallId: previousId });
  }

  provider(delta: ProviderToolCallDelta): void {
    if (this.#closed) {
      return;
    }

    let call = this.#callsByIndex.get(delta.index);
    if (call === undefined) {
      call = this.#createCall(
        delta.id || `pending:${this.#streamId}:${String(delta.index)}`,
        delta.index,
        "",
      );
      this.#nextIndex = Math.max(this.#nextIndex, delta.index + 1);
      this.#callsByIndex.set(delta.index, call);
      this.#callsById.set(call.callId, call);
      this.#state(call, "preparing");
    }

    if (delta.id.length > 0 && call.callId !== delta.id) {
      this.#rename(call, delta.id);
    }
    call.name += this.#content(call, "name", delta.name);
    this.#content(call, "arguments", delta.arguments);
  }

  running(callId: string, name: string): void {
    if (this.#closed) {
      return;
    }
    let call = this.#callsById.get(callId);
    if (call === undefined) {
      call = [...this.#callsByIndex.values()].find(
        (candidate) =>
          candidate.name === name && candidate.callId.startsWith("pending:"),
      );
      if (call !== undefined) {
        this.#rename(call, callId);
      }
    }
    if (call !== undefined) {
      this.#state(call, "running");
      return;
    }

    const created = this.#createCall(callId, this.#nextIndex, "");
    this.#nextIndex += 1;
    this.#callsByIndex.set(created.index, created);
    this.#callsById.set(callId, created);
    this.#state(created, "preparing");
    created.name += this.#content(created, "name", name);
    this.#state(created, "running");
  }

  output(callId: string, channel: "stderr" | "stdout", content: string): void {
    const call = this.#callsById.get(callId);
    if (call !== undefined && !this.#closed) {
      this.#content(call, channel, content);
    }
  }

  completed(callId: string): void {
    this.finish(callId, "completed");
  }

  finish(callId: string, state: ToolStreamTerminalState): void {
    const call = this.#callsById.get(callId);
    if (call === undefined || this.#closed) {
      return;
    }
    this.#state(call, state);
    this.#callsById.delete(callId);
    this.#callsByIndex.delete(call.index);
  }

  failed(callId: string, error: unknown): void {
    this.finish(callId, errorState(error));
  }

  close(state: Extract<ToolStreamState, "canceled" | "failed">): void {
    if (this.#closed) {
      return;
    }
    this.#clear(state);
    this.#closed = true;
    this.#flush();
  }

  #state(call: ActiveToolStream, state: ToolStreamState): void {
    this.#publish(call, { state });
  }

  #content(
    call: ActiveToolStream,
    channel: ToolStreamChannel,
    value: string,
  ): string {
    if (value.length === 0 || call.truncated.has(channel)) {
      return "";
    }

    const key = bytesKey(channel);
    const remaining = MAXIMUM_TOOL_STREAM_BODY_BYTES - call[key];
    const accepted = truncateUtf8(value, Math.max(remaining, 0));
    let rest = accepted;
    while (rest.length > 0) {
      const chunk = truncateUtf8(rest, MAXIMUM_TOOL_STREAM_DELTA_BYTES);
      if (chunk.length === 0) {
        break;
      }
      this.#publish(call, { channel, content: chunk });
      rest = rest.slice(chunk.length);
    }
    call[key] += Buffer.byteLength(accepted);

    if (Buffer.byteLength(value) > Buffer.byteLength(accepted)) {
      call.truncated.add(channel);
      call[key] += TRUNCATED_MARKER_BYTES;
      this.#publish(call, { channel, content: TRUNCATED_MARKER });
    }
    return accepted;
  }

  #publish(
    call: ActiveToolStream,
    delta: QueuedToolStreamDelta["delta"],
  ): void {
    const previous = this.#queued.at(-1);
    if (
      delta.channel !== undefined &&
      delta.content !== undefined &&
      delta.state === undefined &&
      delta.previousCallId === undefined &&
      previous?.callId === call.callId &&
      previous.index === call.index &&
      previous.streamId === call.streamId &&
      previous.delta.channel === delta.channel &&
      previous.delta.content !== undefined &&
      previous.delta.state === undefined &&
      previous.delta.previousCallId === undefined &&
      Buffer.byteLength(previous.delta.content) +
        Buffer.byteLength(delta.content) <=
        MAXIMUM_TOOL_STREAM_DELTA_BYTES
    ) {
      previous.delta.content += delta.content;
      return;
    }

    this.#queued.push({
      callId: call.callId,
      delta,
      index: call.index,
      sequence: call.sequence,
      streamId: call.streamId,
    });
    call.sequence += 1;
    if (this.#flushScheduled) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    for (const {
      callId,
      delta,
      index,
      sequence,
      streamId,
    } of this.#queued.splice(0)) {
      try {
        this.#hub?.publishToolStream(this.#userId, {
          callId,
          ...delta,
          index,
          sequence,
          sessionId: this.#sessionId,
          streamId,
          type: "tool_stream",
        });
      } catch {
        // Live delivery must never interrupt canonical tool execution.
      }
    }
  }
}
