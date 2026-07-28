import { ANSWER_QUESTIONS_REALTIME_OPERATION } from "./ask-questions.ts";
import { isRecord } from "./auth-model.ts";
import { parseJsonRecord } from "./json-record.ts";
import { utf8ByteLength } from "./utf8.ts";

const MAXIMUM_REALTIME_MESSAGE_LENGTH = 128 * 1024 * 1024;
export const USER_REALTIME_MAX_PAYLOAD_LENGTH =
  MAXIMUM_REALTIME_MESSAGE_LENGTH + 1;
const IDENTIFIER_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;
const OPERATION_PATTERN = /^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*){1,7}$/u;

export const SESSION_REALTIME_OPERATIONS = {
  answerQuestions: ANSWER_QUESTIONS_REALTIME_OPERATION,
  compact: "sessions.compact",
  continue: "sessions.continue",
  create: "sessions.create",
  history: "sessions.history",
  models: "sessions.models",
  previewToolUpdate: "sessions.preview_tool_update",
  read: "sessions.read",
  reassign: "sessions.reassign",
  updateProvider: "sessions.update_provider",
  followUp: "sessions.follow_up",
  send: "sessions.send",
  setAutoCompaction: "sessions.set_auto_compaction",
  stop: "sessions.stop",
  steer: "sessions.steer",
  subscribe: "sessions.subscribe",
  updateTools: "sessions.update_tools",
} as const;

export class RealtimeCommandError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RealtimeCommandError";
    this.code = code;
  }
}

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
  if (utf8ByteLength(message) > MAXIMUM_REALTIME_MESSAGE_LENGTH) {
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
