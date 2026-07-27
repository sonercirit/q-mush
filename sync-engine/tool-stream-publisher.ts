import {
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  MAXIMUM_TOOL_STREAM_FIELD_BYTES,
  MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH,
  TOOL_STREAM_TRUNCATED_MARKER,
  canTransitionToolStreamState,
  type ProviderToolCallDelta,
  type RunnerCommandOutputDelta,
  type RunnerCommandResult,
  type ToolStreamChannel,
  type ToolStreamDeltaFrame,
  type ToolStreamState,
  type ToolStreamTerminalState,
} from "../shared/tool-stream.ts";
import { utf8ByteLength, utf8Prefix } from "../shared/utf8.ts";

const MAXIMUM_TOOL_STREAM_BODY_BYTES =
  MAXIMUM_TOOL_STREAM_FIELD_BYTES -
  utf8ByteLength(TOOL_STREAM_TRUNCATED_MARKER);

export interface ToolStreamTransport {
  publishToolStream(
    userId: string,
    frame: ToolStreamDeltaFrame,
    workspaceId?: string,
  ): void;
}

interface ActiveToolStream {
  argumentBytes: number;
  callId: string;
  index: number;
  name: string;
  nameBytes: number;
  nextRunnerSequence: number;
  providerId: string;
  sequence: number;
  stderrBytes: number;
  stdoutBytes: number;
  readonly streamId: string;
  state: ToolStreamState | undefined;
  readonly truncated: Set<ToolStreamChannel>;
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

function errorState(error: unknown): ToolStreamTerminalState {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "canceled";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed[ -]?out/iu.test(message) ? "timed-out" : "failed";
}

export class ToolStreamPublisher {
  readonly #callsById = new Map<string, ActiveToolStream>();
  readonly #callsByIndex = new Map<number, ActiveToolStream>();
  readonly #sessionId: string;
  readonly #transport: ToolStreamTransport | undefined;
  readonly #userId: string;
  readonly #workspaceId: string | undefined;
  #closed = false;
  #nextIndex = 0;
  #streamId: string;

  constructor(options: {
    readonly sessionId: string;
    readonly streamId: string;
    readonly transport?: ToolStreamTransport;
    readonly userId: string;
    readonly workspaceId?: string;
  }) {
    this.#sessionId = options.sessionId;
    this.#streamId = options.streamId;
    this.#transport = options.transport;
    this.#userId = options.userId;
    this.#workspaceId = options.workspaceId;
  }

  startTurn(streamId: string): boolean {
    return this.#begin(streamId);
  }

  reset(streamId: string): boolean {
    return this.#begin(streamId);
  }

  #begin(streamId: string): boolean {
    if (
      this.#closed ||
      streamId.length === 0 ||
      utf8ByteLength(streamId) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }
    this.#clear("canceled");
    this.#streamId = streamId;
    this.#nextIndex = 0;
    return true;
  }

  #clear(state: ToolStreamTerminalState): void {
    for (const call of this.#callsById.values()) {
      this.#state(call, state);
    }
    this.#callsByIndex.clear();
    this.#callsById.clear();
  }

  #createCall(callId: string, index: number): ActiveToolStream {
    return {
      argumentBytes: 0,
      callId,
      index,
      name: "",
      nameBytes: 0,
      nextRunnerSequence: 0,
      providerId: "",
      sequence: 0,
      stderrBytes: 0,
      stdoutBytes: 0,
      streamId: this.#streamId,
      state: undefined,
      truncated: new Set(),
    };
  }

  #insert(call: ActiveToolStream): void {
    this.#callsByIndex.set(call.index, call);
    this.#callsById.set(call.callId, call);
  }

  #rename(call: ActiveToolStream, callId: string): boolean {
    const existing = this.#callsById.get(callId);
    if (
      call.state !== "preparing" ||
      (existing !== undefined && existing !== call)
    ) {
      return false;
    }
    const previousCallId = call.callId;
    this.#callsById.delete(previousCallId);
    call.callId = callId;
    this.#callsById.set(callId, call);
    this.#publish(call, { previousCallId });
    return true;
  }

  provider(delta: ProviderToolCallDelta): boolean {
    if (
      this.#closed ||
      !Number.isSafeInteger(delta.index) ||
      delta.index < 0 ||
      utf8ByteLength(delta.id) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }

    let call = this.#callsByIndex.get(delta.index);
    if (call === undefined) {
      const callId =
        delta.id.length > 0
          ? delta.id
          : `pending:${this.#streamId}:${String(delta.index)}`;
      if (this.#callsById.has(callId)) {
        return false;
      }
      call = this.#createCall(callId, delta.index);
      this.#nextIndex = Math.max(this.#nextIndex, delta.index + 1);
      this.#insert(call);
      this.#state(call, "preparing");
    }

    if (call.state !== "preparing") {
      return false;
    }
    if (delta.id.length > 0) {
      const providerId = call.providerId + delta.id;
      if (utf8ByteLength(providerId) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH) {
        return false;
      }
      call.providerId = providerId;
      if (call.callId !== providerId && !this.#rename(call, providerId)) {
        return false;
      }
    }
    call.name += this.#content(call, "name", delta.name);
    this.#content(call, "arguments", delta.arguments);
    return true;
  }

  running(callId: string, name: string): boolean {
    if (
      this.#closed ||
      callId.length === 0 ||
      utf8ByteLength(callId) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }
    let call = this.#callsById.get(callId);
    if (call === undefined) {
      call = [...this.#callsByIndex.values()].find(
        (candidate) =>
          candidate.name === name && candidate.callId.startsWith("pending:"),
      );
      if (call !== undefined && !this.#rename(call, callId)) {
        return false;
      }
    }
    if (call === undefined) {
      call = this.#createCall(callId, this.#nextIndex);
      this.#nextIndex += 1;
      this.#insert(call);
      this.#state(call, "preparing");
      call.name += this.#content(call, "name", name);
    }
    return this.#state(call, "running");
  }

  output(callId: string, delta: RunnerCommandOutputDelta): boolean {
    const call = this.#activeCall(callId, "running");
    if (
      call === undefined ||
      !Number.isSafeInteger(delta.sequence) ||
      delta.sequence < 0 ||
      delta.sequence !== call.nextRunnerSequence
    ) {
      return false;
    }
    call.nextRunnerSequence += 1;
    this.#content(call, delta.channel, delta.content);
    return true;
  }

  result(callId: string, result: RunnerCommandResult): boolean {
    return this.finish(callId, result.state);
  }

  completed(callId: string): boolean {
    return this.finish(callId, "completed");
  }

  finish(callId: string, state: ToolStreamTerminalState): boolean {
    const call = this.#activeCall(callId);
    if (call === undefined) {
      return false;
    }
    if (!this.#state(call, state)) {
      return false;
    }
    this.#callsById.delete(callId);
    this.#callsByIndex.delete(call.index);
    return true;
  }

  failed(callId: string, error: unknown): boolean {
    return this.finish(callId, errorState(error));
  }

  #activeCall(
    callId: string,
    requiredState?: ToolStreamState,
  ): ActiveToolStream | undefined {
    if (this.#closed) {
      return undefined;
    }
    const call = this.#callsById.get(callId);
    return requiredState === undefined || call?.state === requiredState
      ? call
      : undefined;
  }

  close(state: Extract<ToolStreamState, "canceled" | "failed">): void {
    if (this.#closed) {
      return;
    }
    this.#clear(state);
    this.#closed = true;
  }

  #state(call: ActiveToolStream, state: ToolStreamState): boolean {
    if (!canTransitionToolStreamState(call.state, state)) {
      return false;
    }
    call.state = state;
    this.#publish(call, { state });
    return true;
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
    const accepted = utf8Prefix(value, Math.max(remaining, 0));
    let rest = accepted;
    while (rest.length > 0) {
      const chunk = utf8Prefix(rest, MAXIMUM_TOOL_STREAM_DELTA_BYTES);
      if (chunk.length === 0) {
        break;
      }
      this.#publish(call, { channel, content: chunk });
      rest = rest.slice(chunk.length);
    }
    call[key] += utf8ByteLength(accepted);

    if (utf8ByteLength(value) > utf8ByteLength(accepted)) {
      call.truncated.add(channel);
      call[key] += utf8ByteLength(TOOL_STREAM_TRUNCATED_MARKER);
      this.#publish(call, {
        channel,
        content: TOOL_STREAM_TRUNCATED_MARKER,
      });
    }
    return accepted;
  }

  #publish(
    call: ActiveToolStream,
    change: Pick<
      ToolStreamDeltaFrame,
      "channel" | "content" | "previousCallId" | "state"
    >,
  ): void {
    const frame: ToolStreamDeltaFrame = {
      callId: call.callId,
      index: call.index,
      sequence: call.sequence,
      sessionId: this.#sessionId,
      streamId: call.streamId,
      type: "tool_stream",
      ...change,
    };
    call.sequence += 1;
    try {
      this.#transport?.publishToolStream(
        this.#userId,
        frame,
        this.#workspaceId,
      );
    } catch {
      // Live delivery must never interrupt canonical tool execution.
    }
  }
}
