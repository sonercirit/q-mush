import type { ToolStreamEntry } from "../../shared/tool-stream.ts";

export function testToolStreamEntry(sessionId = "session-1"): ToolStreamEntry {
  return {
    arguments: "{}",
    callId: "call-1",
    index: 0,
    name: "read",
    sequence: 3,
    sessionId,
    state: "running",
    stderr: "",
    stdout: "snapshot",
    streamId: "turn-1",
  };
}
