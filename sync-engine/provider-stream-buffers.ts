import type { AgentToolCall } from "../shared/agent-loop.ts";
import { requireRecord } from "../shared/validation.ts";
import {
  emitProviderDelta,
  emitToolCallDelta,
  sortedToolCalls,
  type PartialProviderToolCall,
} from "./provider-stream-helpers.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

interface StreamBuffers {
  readonly onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly text: string[];
  readonly thinking: string[];
}

export interface BufferedAccumulator {
  readonly appendToolCallArguments: (index: number, partial: string) => void;
  readonly buffers: StreamBuffers;
  readonly emitToolCallProgress: (
    index: number,
    delta: PartialProviderToolCall,
  ) => void;
  readonly pushText: (content: string) => void;
  readonly pushThinking: (thinking: string) => void;
  readonly readEvent: (
    value: unknown,
    message: string,
  ) => Readonly<Record<string, unknown>>;
  readonly receivedEvent: () => boolean;
  readonly recordedToolCalls: () => readonly AgentToolCall[];
  readonly registerToolCall: (
    index: number,
    call: PartialProviderToolCall,
  ) => void;
  readonly setReceivedEvent: () => void;
  readonly toolCalls: Map<number, PartialProviderToolCall>;
}

export function createBufferedAccumulator(
  onDelta?: (delta: ProviderTextDelta) => void,
): BufferedAccumulator {
  const buffers: StreamBuffers = { onDelta, text: [], thinking: [] };
  const toolCalls = new Map<number, PartialProviderToolCall>();
  let hasReceivedEvent = false;
  const emitToolCallProgress = (
    index: number,
    delta: PartialProviderToolCall,
  ): void => {
    emitToolCallDelta(buffers.onDelta, { ...delta, index });
  };
  const appendToolCallArguments = (index: number, partial: string): void => {
    const call = toolCalls.get(index);
    if (call === undefined) {
      throw new Error(
        "The provider returned a tool-call delta before its call",
      );
    }
    toolCalls.set(index, { ...call, arguments: call.arguments + partial });
    emitToolCallProgress(index, { arguments: partial, id: "", name: "" });
  };
  return {
    appendToolCallArguments,
    buffers,
    emitToolCallProgress,
    pushText: (content) => {
      buffers.text.push(content);
      emitProviderDelta(buffers.onDelta, content, "");
    },
    pushThinking: (thinking) => {
      buffers.thinking.push(thinking);
      emitProviderDelta(buffers.onDelta, "", thinking);
    },
    readEvent: (value, message) => {
      hasReceivedEvent = true;
      return requireRecord(value, message);
    },
    receivedEvent: () => hasReceivedEvent,
    recordedToolCalls: () => sortedToolCalls(toolCalls),
    registerToolCall: (index, call) => {
      toolCalls.set(index, call);
      emitToolCallDelta(buffers.onDelta, { ...call, index });
    },
    setReceivedEvent: () => {
      hasReceivedEvent = true;
    },
    toolCalls,
  };
}
