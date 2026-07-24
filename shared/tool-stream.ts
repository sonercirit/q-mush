export const MAXIMUM_TOOL_STREAM_DELTA_BYTES = 32 * 1_024;
export const MAXIMUM_TOOL_STREAM_FIELD_BYTES = 256 * 1_024;
export const MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH = 1_024;
export const MAXIMUM_TOOL_STREAMS_PER_SESSION = 100;

export type ToolStreamTerminalState =
  "completed" | "failed" | "canceled" | "timed-out";

const TOOL_STREAM_TERMINAL_STATES: readonly ToolStreamTerminalState[] = [
  "canceled",
  "completed",
  "failed",
  "timed-out",
];

export function isToolStreamTerminalState(
  value: unknown,
): value is ToolStreamTerminalState {
  return TOOL_STREAM_TERMINAL_STATES.some((state) => state === value);
}

export function aggregateToolStreamState(
  states: ReadonlySet<ToolStreamTerminalState>,
): ToolStreamTerminalState {
  for (const candidate of ["timed-out", "canceled", "failed"] as const) {
    if (states.has(candidate)) {
      return candidate;
    }
  }
  return "completed";
}

export type ToolStreamState = "preparing" | "running" | ToolStreamTerminalState;

export type ToolStreamChannel = "arguments" | "name" | "stderr" | "stdout";

export interface ToolStreamDelta {
  readonly callId: string;
  readonly channel?: ToolStreamChannel;
  readonly content?: string;
  readonly index: number;
  readonly previousCallId?: string;
  readonly sequence: number;
  readonly sequenceStart?: number;
  readonly sessionId: string;
  readonly state?: ToolStreamState;
  readonly streamId: string;
}

export interface ToolStreamEntry {
  readonly arguments: string;
  readonly callId: string;
  readonly index: number;
  readonly name: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly state: ToolStreamState;
  readonly stderr: string;
  readonly stdout: string;
  readonly streamId: string;
}
