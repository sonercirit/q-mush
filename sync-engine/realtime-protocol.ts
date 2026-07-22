import { parseJsonRecord } from "../shared/json-record.ts";

export interface QmushClientMessage {
  readonly type: "refresh";
}

export type RunnerClientMessage =
  | {
      readonly commandId: string;
      readonly output: string;
      readonly type: "result";
    }
  | { readonly type: "heartbeat" };

export interface RunnerConnectMessage {
  readonly architecture: string;
  readonly machineId: string;
  readonly name: string;
  readonly platform: string;
  readonly type: "connect";
}

function parseRecord(message: string): Readonly<Record<string, unknown>> {
  return parseJsonRecord(message, "The WebSocket message was invalid");
}

export function readQmushClientMessage(message: string): QmushClientMessage {
  const value = parseRecord(message);

  if (value["type"] !== "refresh") {
    throw new Error("The Q Mush WebSocket message was invalid");
  }

  return { type: "refresh" };
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
  const output = value["output"];

  if (
    value["type"] !== "result" ||
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    typeof output !== "string"
  ) {
    throw new Error("The runner WebSocket message was invalid");
  }

  return { commandId, output, type: "result" };
}
