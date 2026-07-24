import { parseJsonRecord } from "../shared/json-record.ts";

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
  if (message.length > 16 * 1024 * 1024) {
    throw new Error("The WebSocket message was too large");
  }
  return parseJsonRecord(message, "The WebSocket message was invalid");
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
