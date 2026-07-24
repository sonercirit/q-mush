import { isRecord } from "./auth-model.ts";
import { parseJsonRecord } from "./json-record.ts";

const MAXIMUM_REALTIME_MESSAGE_LENGTH = 128 * 1024 * 1024;
export const USER_REALTIME_MAX_PAYLOAD_LENGTH =
  MAXIMUM_REALTIME_MESSAGE_LENGTH + 1;
const IDENTIFIER_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;
const OPERATION_PATTERN = /^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*){1,7}$/u;

export const SESSION_REALTIME_OPERATIONS = {
  compact: "sessions.compact",
  continue: "sessions.continue",
  create: "sessions.create",
  models: "sessions.models",
  read: "sessions.read",
  send: "sessions.send",
  setAutoCompaction: "sessions.set_auto_compaction",
  stop: "sessions.stop",
  subscribe: "sessions.subscribe",
} as const;

export type UserRealtimeCommand = Readonly<{
  commandId: string;
  idempotencyKey: string;
  operation: string;
  payload: Readonly<Record<string, unknown>>;
  type: "command";
}>;

export class UserRealtimeProtocolError extends Error {
  readonly commandId: string | undefined;

  constructor(message: string, commandId?: string) {
    super(message);
    this.name = "UserRealtimeProtocolError";
    this.commandId = commandId;
  }
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

export function readUserRealtimeCommand(message: string): UserRealtimeCommand {
  if (message.length > MAXIMUM_REALTIME_MESSAGE_LENGTH) {
    throw new UserRealtimeProtocolError("The realtime command was too large");
  }

  let value: Readonly<Record<string, unknown>>;
  try {
    value = parseJsonRecord(message, "The realtime command was invalid");
  } catch {
    throw new UserRealtimeProtocolError("The realtime command was invalid");
  }

  const commandId = identifier(value["commandId"]);
  const idempotencyKey = identifier(value["idempotencyKey"]);
  const operation = value["operation"];
  const payload = value["payload"];
  const keys = Object.keys(value);

  if (
    value["type"] !== "command" ||
    commandId === undefined ||
    idempotencyKey === undefined ||
    typeof operation !== "string" ||
    !OPERATION_PATTERN.test(operation) ||
    !isRecord(payload) ||
    keys.length !== 5 ||
    !keys.every((key) =>
      ["commandId", "idempotencyKey", "operation", "payload", "type"].includes(
        key,
      ),
    )
  ) {
    throw new UserRealtimeProtocolError(
      "The realtime command was invalid",
      commandId,
    );
  }

  return {
    commandId,
    idempotencyKey,
    operation,
    payload,
    type: "command",
  };
}
