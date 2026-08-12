import type { AgentToolCall } from "../shared/agent-loop.ts";
import { requireRecord } from "../shared/validation.ts";
import {
  emitProviderDelta,
  emitToolCallDelta,
  sortedToolCalls,
  type PartialProviderToolCall,
} from "./provider-stream-helpers.ts";
import type { ProviderTextDelta } from "./provider-stream.ts";

export interface StreamBuffers {
  readonly onDelta: ((delta: ProviderTextDelta) => void) | undefined;
  readonly text: string[];
  readonly thinking: string[];
}

function createStreamBuffers(
  onDelta?: (delta: ProviderTextDelta) => void,
): StreamBuffers {
  return { onDelta, text: [], thinking: [] };
}

export abstract class BufferedAccumulator {
  readonly buffers: StreamBuffers;
  protected readonly toolCalls = new Map<number, PartialProviderToolCall>();
  receivedEvent = false;

  constructor(onDelta?: (delta: ProviderTextDelta) => void) {
    this.buffers = createStreamBuffers(onDelta);
  }

  protected readEvent(value: unknown, message: string) {
    this.receivedEvent = true;
    return requireRecord(value, message);
  }

  protected pushText(content: string): void {
    this.buffers.text.push(content);
    emitProviderDelta(this.buffers.onDelta, content, "");
  }

  protected pushThinking(thinking: string): void {
    this.buffers.thinking.push(thinking);
    emitProviderDelta(this.buffers.onDelta, "", thinking);
  }

  protected registerToolCall(
    index: number,
    call: PartialProviderToolCall,
  ): void {
    this.toolCalls.set(index, call);
    emitToolCallDelta(this.buffers.onDelta, { ...call, index });
  }

  protected appendToolCallArguments(index: number, partial: string): void {
    const call = this.toolCalls.get(index);

    if (call === undefined) {
      throw new Error(
        "The provider returned a tool-call delta before its call",
      );
    }

    this.toolCalls.set(index, {
      ...call,
      arguments: call.arguments + partial,
    });
    this.emitToolCallProgress(index, { arguments: partial, id: "", name: "" });
  }

  protected emitToolCallProgress(
    index: number,
    delta: PartialProviderToolCall,
  ): void {
    emitToolCallDelta(this.buffers.onDelta, { ...delta, index });
  }

  protected recordedToolCalls(): readonly AgentToolCall[] {
    return sortedToolCalls(this.toolCalls);
  }
}
