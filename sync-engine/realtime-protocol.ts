import { parseJsonRecord } from "../shared/json-record.ts";
import { isNonnegativeSafeInteger } from "../shared/number.ts";
import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";
import {
  isToolStreamTerminalState,
  MAXIMUM_TOOL_STREAM_DELTA_BYTES,
  MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH,
  type ToolStreamTerminalState,
} from "../shared/tool-stream.ts";
import { utf8ByteLength } from "../shared/utf8.ts";

export type QmushClientMessage =
  | { readonly type: "refresh" }
  | {
      readonly sessionId: string;
      readonly streamId: string;
      readonly type: "sync_tools";
    };

export type RunnerClientMessage =
  | {
      readonly channel: "stderr" | "stdout";
      readonly commandId: string;
      readonly content: string;
      readonly sequence: number;
      readonly type: "output";
    }
  | (RunnerCommandResult & {
      readonly commandId: string;
      readonly type: "result";
    })
  | { readonly type: "heartbeat" };

export interface RunnerConnectMessage {
  readonly architecture: string;
  readonly machineId: string;
  readonly name: string;
  readonly platform: string;
  readonly type: "connect";
}

const MAXIMUM_RUNNER_IDENTIFIER_LENGTH = 200;

function runnerTerminalState(
  value: unknown,
): ToolStreamTerminalState | undefined {
  return isToolStreamTerminalState(value) ? value : undefined;
}

function parseRecord(message: string): Readonly<Record<string, unknown>> {
  return parseJsonRecord(message, "The WebSocket message was invalid");
}

export function readQmushClientMessage(message: string): QmushClientMessage {
  const value = parseRecord(message);

  if (value["type"] === "refresh") {
    return { type: "refresh" };
  }
  const sessionId = value["sessionId"];
  const streamId = value["streamId"];
  if (
    value["type"] !== "sync_tools" ||
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH ||
    typeof streamId !== "string" ||
    streamId.length === 0 ||
    streamId.length > MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH
  ) {
    throw new Error("The Q Mush WebSocket message was invalid");
  }

  return { sessionId, streamId, type: "sync_tools" };
}

export function readRunnerConnectMessage(
  message: string,
): RunnerConnectMessage {
  const value = parseRecord(message);
  const architecture = value["architecture"];
  const machineId = value["machineId"];
  const name = value["name"];
  const platform = value["platform"];

  if (
    value["type"] !== "connect" ||
    typeof architecture !== "string" ||
    typeof machineId !== "string" ||
    typeof name !== "string" ||
    typeof platform !== "string"
  ) {
    throw new Error("The runner connection message was invalid");
  }

  return { architecture, machineId, name, platform, type: "connect" };
}

export function readRunnerClientMessage(message: string): RunnerClientMessage {
  const value = parseRecord(message);

  if (value["type"] === "heartbeat") {
    return { type: "heartbeat" };
  }

  const commandId = value["commandId"];
  if (value["type"] === "output") {
    const channel = value["channel"];
    const content = value["content"];
    const sequence = value["sequence"];
    if (
      typeof commandId !== "string" ||
      commandId.length === 0 ||
      commandId.length > MAXIMUM_RUNNER_IDENTIFIER_LENGTH ||
      (channel !== "stderr" && channel !== "stdout") ||
      typeof content !== "string" ||
      content.length === 0 ||
      utf8ByteLength(content) > MAXIMUM_TOOL_STREAM_DELTA_BYTES ||
      !isNonnegativeSafeInteger(sequence)
    ) {
      throw new Error("The runner WebSocket message was invalid");
    }
    return { channel, commandId, content, sequence, type: "output" };
  }

  const output = value["output"];
  const state = runnerTerminalState(value["state"]);

  if (
    value["type"] !== "result" ||
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    commandId.length > MAXIMUM_RUNNER_IDENTIFIER_LENGTH ||
    typeof output !== "string" ||
    state === undefined
  ) {
    throw new Error("The runner WebSocket message was invalid");
  }

  return { commandId, output, state, type: "result" };
}
