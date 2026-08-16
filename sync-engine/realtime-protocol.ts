import { parseJsonRecord } from "../shared/json-record.ts";
import type { RunnerCommandResult } from "../shared/runner-command-broker.ts";
import type {
  RunnerActivationReceipt,
  RunnerConnectMetadata,
} from "../shared/runner-realtime-protocol.ts";
import {
  isRunnerCommandOutputDelta,
  isRunnerCommandResult,
} from "../shared/tool-stream.ts";
import { readBoundedString } from "../shared/validation.ts";

export type RunnerClientMessage =
  | {
      readonly commandId: string;
      readonly type: "cancellation_received";
    }
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
  | {
      readonly restartId: string;
      readonly type: "restart" | "restart_escalate";
    }
  | { readonly type: "heartbeat" };

export interface RunnerConnectMessage extends RunnerConnectMetadata {
  readonly activationReceipt?: RunnerActivationReceipt;
  readonly processNonce?: string;
  readonly restartId?: string;
  readonly type: "connect";
}

export type RunnerRegistrationClientMessage =
  | { readonly registrationId: string; readonly type: "registration_accept" }
  | {
      readonly registrationId: string;
      readonly type: "registration_active_received";
    }
  | {
      readonly registrationId: string;
      readonly type: "registration_finalized_received";
    }
  | {
      readonly registrationId: string;
      readonly type: "registration_operational_received";
    }
  | { readonly registrationId: string; readonly type: "registration_received" };

function parseRecord(message: string): Readonly<Record<string, unknown>> {
  return parseJsonRecord(message, "The WebSocket message was invalid");
}

function readActivationReceipt(
  value: unknown,
): RunnerActivationReceipt | undefined {
  if (value === undefined) {
    return undefined;
  }
  const receipt = readBoundedString(value, 200);
  if (receipt === undefined) {
    throw new Error("The runner connection message was invalid");
  }
  return { value: receipt };
}

export function readRunnerConnectMessage(
  message: string,
): RunnerConnectMessage {
  const value = parseRecord(message);
  const activationReceipt = readActivationReceipt(value["activationReceipt"]);
  const architecture = value["architecture"];
  const machineId = value["machineId"];
  const name = value["name"];
  const platform = value["platform"];
  const restartId = value["restartId"];

  if (
    !Object.keys(value).every((key) =>
      [
        "activationReceipt",
        "architecture",
        "machineId",
        "name",
        "platform",
        "processNonce",
        "restartId",
        "type",
      ].includes(key),
    ) ||
    value["type"] !== "connect" ||
    typeof architecture !== "string" ||
    typeof machineId !== "string" ||
    typeof name !== "string" ||
    typeof platform !== "string" ||
    (value["processNonce"] !== undefined &&
      (typeof value["processNonce"] !== "string" ||
        value["processNonce"].length === 0 ||
        value["processNonce"].length > 200)) ||
    (restartId !== undefined &&
      (typeof restartId !== "string" ||
        restartId.length === 0 ||
        restartId.length > 200))
  ) {
    throw new Error("The runner connection message was invalid");
  }

  return {
    ...(activationReceipt === undefined ? {} : { activationReceipt }),
    architecture,
    machineId,
    name,
    platform,
    ...(typeof value["processNonce"] === "string"
      ? { processNonce: value["processNonce"] }
      : {}),
    ...(typeof restartId === "string" ? { restartId } : {}),
    type: "connect",
  };
}

export function readRunnerRegistrationMessage(
  message: string,
): RunnerRegistrationClientMessage {
  const value = parseRecord(message);
  const registrationId = value["registrationId"];
  if (
    !Object.keys(value).every(
      (key) => key === "registrationId" || key === "type",
    ) ||
    (value["type"] !== "registration_accept" &&
      value["type"] !== "registration_active_received" &&
      value["type"] !== "registration_finalized_received" &&
      value["type"] !== "registration_operational_received" &&
      value["type"] !== "registration_received") ||
    typeof registrationId !== "string" ||
    registrationId.length === 0 ||
    registrationId.length > 200
  ) {
    throw new Error("The runner registration message was invalid");
  }
  return { registrationId, type: value["type"] };
}

export function readRunnerClientMessage(message: string): RunnerClientMessage {
  const value = parseRecord(message);

  if (value["type"] === "heartbeat" && Object.keys(value).length === 1) {
    return { type: "heartbeat" };
  }

  if (value["type"] === "restart" || value["type"] === "restart_escalate") {
    const restartId = value["restartId"];
    if (
      Object.keys(value).length !== 2 ||
      typeof restartId !== "string" ||
      restartId.length === 0 ||
      restartId.length > 200
    ) {
      throw new Error("The runner WebSocket message was invalid");
    }
    return { restartId, type: value["type"] };
  }

  const commandId = value["commandId"];
  if (
    typeof commandId !== "string" ||
    commandId.length === 0 ||
    commandId.length > 200
  ) {
    throw new Error("The runner WebSocket message was invalid");
  }

  if (value["type"] === "cancellation_received") {
    if (Object.keys(value).length !== 2) {
      throw new Error("The runner WebSocket message was invalid");
    }
    return { commandId, type: "cancellation_received" };
  }

  if (value["type"] === "output") {
    const delta = {
      channel: value["channel"],
      content: value["content"],
      sequence: value["sequence"],
    };
    if (Object.keys(value).length !== 5 || !isRunnerCommandOutputDelta(delta)) {
      throw new Error("The runner WebSocket message was invalid");
    }
    return { ...delta, commandId, type: "output" };
  }

  const result = { output: value["output"], state: value["state"] };
  if (
    value["type"] !== "result" ||
    Object.keys(value).length !== 4 ||
    !isRunnerCommandResult(result)
  ) {
    throw new Error("The runner WebSocket message was invalid");
  }

  return { ...result, commandId, type: "result" };
}
