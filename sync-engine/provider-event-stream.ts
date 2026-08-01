import type { AgentModelStep } from "../shared/agent-loop.ts";
import {
  createProviderStreamAccumulator,
  type ProviderTextDelta,
} from "./provider-stream.ts";

function eventData(block: string): string {
  return block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
}

function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error("The provider returned an invalid event stream", {
      cause: error,
    });
  }
}

export async function readProviderEventStream(
  response: Response,
  protocol: "chat_completions" | "responses",
  onDelta?: (delta: ProviderTextDelta) => void,
): Promise<AgentModelStep> {
  const accumulator = createProviderStreamAccumulator(protocol, onDelta);
  const body = response.body;
  if (body === null) {
    throw new Error("The provider returned no event stream");
  }

  const decoder = new TextDecoder();
  let buffered = "";
  const streamState = { done: false };
  const processBlocks = (final: boolean): void => {
    buffered = buffered.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const blocks = buffered.split("\n\n");
    buffered = final ? "" : (blocks.pop() ?? "");

    for (const block of blocks) {
      const data = eventData(block);
      if (data === "[DONE]") {
        streamState.done = true;
      } else if (data.length > 0) {
        accumulator.push(parseEventData(data));
      }
    }
  };

  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    processBlocks(false);
  }
  buffered += decoder.decode();
  if (buffered.length > 0) {
    buffered += "\n\n";
  }
  processBlocks(true);

  if (!accumulator.receivedEvent) {
    throw new Error("The provider response ended before completion");
  }
  if (protocol === "chat_completions" && !streamState.done) {
    throw new Error("The provider response ended before completion");
  }
  return accumulator.finish();
}
