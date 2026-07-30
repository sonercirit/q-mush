import type { AgentSessionMessage } from "../../shared/session-model.ts";
import type { ToolStreamEntry } from "../../shared/tool-stream.ts";
import { createDisplaySessionMessage } from "../session-message.ts";

export function testAssistantToolCall(
  callId: string,
  arguments_: string,
  name: string,
  overrides: Partial<AgentSessionMessage> = {},
): AgentSessionMessage {
  return {
    ...createDisplaySessionMessage({
      content: "",
      createdAt: 1,
      id: "assistant-tool-call",
      role: "assistant",
    }),
    toolCalls: [{ arguments: arguments_, id: callId, name }],
    ...overrides,
  };
}

export function testToolStream(
  callId: string,
  arguments_: string,
  name: string,
  overrides: Partial<ToolStreamEntry> = {},
): ToolStreamEntry {
  return {
    arguments: arguments_,
    callId,
    index: 0,
    name,
    sequence: 1,
    sessionId: "session-1",
    state: "running",
    stderr: "",
    stdout: "waiting",
    streamId: "stream-1",
    ...overrides,
  };
}
