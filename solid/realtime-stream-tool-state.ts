import type {
  ToolStreamEntry,
  ToolStreamTerminalState,
} from "../shared/tool-stream.ts";

interface ActiveToolState {
  readonly entry: ToolStreamEntry;
  readonly kind: "active";
}

export interface TerminalToolState {
  readonly callId: string;
  readonly index: number;
  readonly kind: "terminal";
  readonly sequence: number;
  readonly sessionId: string;
  readonly state: ToolStreamTerminalState;
  readonly streamId: string;
}

export type RetainedToolState = ActiveToolState | TerminalToolState;

export function toolStateSessionId(state: RetainedToolState): string {
  return state.kind === "active" ? state.entry.sessionId : state.sessionId;
}

export function terminalToolState(entry: ToolStreamEntry): TerminalToolState {
  if (entry.state === "preparing" || entry.state === "running") {
    throw new TypeError("A tool tombstone must be terminal");
  }
  return {
    callId: entry.callId,
    index: entry.index,
    kind: "terminal",
    sequence: entry.sequence,
    sessionId: entry.sessionId,
    state: entry.state,
    streamId: entry.streamId,
  };
}

export function tombstoneEntry(tombstone: TerminalToolState): ToolStreamEntry {
  return {
    arguments: "",
    callId: tombstone.callId,
    index: tombstone.index,
    name: "",
    sequence: tombstone.sequence,
    sessionId: tombstone.sessionId,
    state: tombstone.state,
    stderr: "",
    stdout: "",
    streamId: tombstone.streamId,
  };
}
