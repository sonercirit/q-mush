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
  const keys: Record<
    ToolStreamChannel,
    "argumentBytes" | "nameBytes" | "stderrBytes" | "stdoutBytes"
  > = {
    arguments: "argumentBytes",
    name: "nameBytes",
    stderr: "stderrBytes",
    stdout: "stdoutBytes",
  };
  return keys[channel];
}

function errorState(error: unknown): ToolStreamTerminalState {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "canceled";
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed[ -]?out/iu.test(message) ? "timed-out" : "failed";
}

export interface ToolStreamPublisher {
  startStep(streamId: string): boolean;
  reset(streamId: string): boolean;
  provider(delta: ProviderToolCallDelta): boolean;
  running(callId: string, name: string, arguments_?: string): boolean;
  output(callId: string, delta: RunnerCommandOutputDelta): boolean;
  result(callId: string, result: RunnerCommandResult): boolean;
  completed(callId: string): boolean;
  finish(callId: string, state: ToolStreamTerminalState): boolean;
  failed(callId: string, error: unknown): boolean;
  close(state: Extract<ToolStreamState, "canceled" | "failed">): void;
}

export function createToolStreamPublisher(options: {
  readonly sessionId: string;
  readonly streamId: string;
  readonly transport?: ToolStreamTransport;
  readonly userId: string;
  readonly workspaceId?: string;
}): ToolStreamPublisher {
  const callsById = new Map<string, ActiveToolStream>();
  const callsByIndex = new Map<number, ActiveToolStream>();
  let closed = false;
  let nextIndex = 0;
  let currentStreamId = options.streamId;

  function startStep(streamId: string): boolean {
    return begin(streamId);
  }

  function reset(streamId: string): boolean {
    return begin(streamId);
  }

  function begin(streamId: string): boolean {
    if (
      closed ||
      streamId.length === 0 ||
      utf8ByteLength(streamId) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }
    clear("canceled");
    currentStreamId = streamId;
    nextIndex = 0;
    return true;
  }

  function clear(terminalState: ToolStreamTerminalState): void {
    for (const call of callsById.values()) {
      state(call, terminalState);
    }
    callsByIndex.clear();
    callsById.clear();
  }

  function createCall(callId: string, index: number): ActiveToolStream {
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
      streamId: currentStreamId,
      state: undefined,
      truncated: new Set(),
    };
  }

  function insert(call: ActiveToolStream): void {
    callsByIndex.set(call.index, call);
    callsById.set(call.callId, call);
  }

  function insertPreparingCall(
    callId: string,
    index: number,
  ): ActiveToolStream {
    const call = createCall(callId, index);
    insert(call);
    state(call, "preparing");
    return call;
  }

  function rename(call: ActiveToolStream, callId: string): boolean {
    const existing = callsById.get(callId);
    if (
      call.state !== "preparing" ||
      (existing !== undefined && existing !== call)
    ) {
      return false;
    }
    const previousCallId = call.callId;
    callsById.delete(previousCallId);
    call.callId = callId;
    callsById.set(callId, call);
    publish(call, { previousCallId });
    return true;
  }

  function provider(delta: ProviderToolCallDelta): boolean {
    if (
      closed ||
      !Number.isSafeInteger(delta.index) ||
      delta.index < 0 ||
      utf8ByteLength(delta.id) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }

    let call = callsByIndex.get(delta.index);
    if (call === undefined) {
      const callId =
        delta.id.length > 0
          ? delta.id
          : `pending:${currentStreamId}:${String(delta.index)}`;
      if (callsById.has(callId)) {
        return false;
      }
      call = insertPreparingCall(callId, delta.index);
      nextIndex = Math.max(nextIndex, delta.index + 1);
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
      if (call.callId !== providerId && !rename(call, providerId)) {
        return false;
      }
    }
    call.name += content(call, "name", delta.name);
    content(call, "arguments", delta.arguments);
    return true;
  }

  function running(callId: string, name: string, arguments_?: string): boolean {
    if (
      closed ||
      callId.length === 0 ||
      utf8ByteLength(callId) > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
    ) {
      return false;
    }
    let call = callsById.get(callId);
    if (call === undefined) {
      call = [...callsByIndex.values()].find(
        (candidate) =>
          candidate.name === name && candidate.callId.startsWith("pending:"),
      );
      if (call !== undefined && !rename(call, callId)) {
        return false;
      }
    }
    if (call === undefined) {
      call = insertPreparingCall(callId, nextIndex);
      nextIndex += 1;
    }
    if (call.name.length === 0) {
      call.name += content(call, "name", name);
    }
    if (call.argumentBytes === 0 && arguments_ !== undefined) {
      content(call, "arguments", arguments_);
    }
    return state(call, "running");
  }

  function output(callId: string, delta: RunnerCommandOutputDelta): boolean {
    const call = activeCall(callId, "running");
    if (
      call === undefined ||
      !Number.isSafeInteger(delta.sequence) ||
      delta.sequence < 0 ||
      delta.sequence !== call.nextRunnerSequence
    ) {
      return false;
    }
    call.nextRunnerSequence += 1;
    content(call, delta.channel, delta.content);
    return true;
  }

  function result(callId: string, result: RunnerCommandResult): boolean {
    return finish(callId, result.state);
  }

  function completed(callId: string): boolean {
    return finish(callId, "completed");
  }

  function finish(
    callId: string,
    terminalState: ToolStreamTerminalState,
  ): boolean {
    const call = activeCall(callId);
    if (call === undefined) {
      return false;
    }
    if (!state(call, terminalState)) {
      return false;
    }
    callsById.delete(callId);
    callsByIndex.delete(call.index);
    return true;
  }

  function failed(callId: string, error: unknown): boolean {
    return finish(callId, errorState(error));
  }

  function activeCall(
    callId: string,
    requiredState?: ToolStreamState,
  ): ActiveToolStream | undefined {
    if (closed) {
      return undefined;
    }
    const call = callsById.get(callId);
    return requiredState === undefined || call?.state === requiredState
      ? call
      : undefined;
  }

  function close(state: Extract<ToolStreamState, "canceled" | "failed">): void {
    if (closed) {
      return;
    }
    clear(state);
    closed = true;
  }

  function state(call: ActiveToolStream, state: ToolStreamState): boolean {
    if (!canTransitionToolStreamState(call.state, state)) {
      return false;
    }
    call.state = state;
    publish(call, { state });
    return true;
  }

  function content(
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
      publish(call, { channel, content: chunk });
      rest = rest.slice(chunk.length);
    }
    call[key] += utf8ByteLength(accepted);

    if (utf8ByteLength(value) > utf8ByteLength(accepted)) {
      call.truncated.add(channel);
      call[key] += utf8ByteLength(TOOL_STREAM_TRUNCATED_MARKER);
      publish(call, {
        channel,
        content: TOOL_STREAM_TRUNCATED_MARKER,
      });
    }
    return accepted;
  }

  function publish(
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
      sessionId: options.sessionId,
      streamId: call.streamId,
      type: "tool_stream",
      ...change,
    };
    call.sequence += 1;
    try {
      options.transport?.publishToolStream(
        options.userId,
        frame,
        options.workspaceId,
      );
    } catch {
      // Live delivery must never interrupt canonical tool execution.
    }
  }
  return {
    close,
    completed,
    failed,
    finish,
    output,
    provider,
    reset,
    result,
    running,
    startStep,
  };
}
