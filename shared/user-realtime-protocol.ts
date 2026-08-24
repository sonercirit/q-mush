import { ANSWER_QUESTIONS_REALTIME_OPERATION } from "./ask-questions.ts";
import { isRecord } from "./auth-model.ts";
import { parseJsonRecord } from "./json-record.ts";
import { MAXIMUM_REALTIME_MESSAGE_BYTES } from "./realtime-limits.ts";
import { utf8ByteLength } from "./utf8.ts";

export const USER_REALTIME_MAX_PAYLOAD_LENGTH =
  MAXIMUM_REALTIME_MESSAGE_BYTES + 1;
const IDENTIFIER_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;
const OPERATION_PATTERN = /^[a-z][a-z\d_]*(?:\.[a-z][a-z\d_]*){1,7}$/u;

export const SESSION_REALTIME_OPERATIONS = {
  answerQuestions: ANSWER_QUESTIONS_REALTIME_OPERATION,
  cancelPendingInput: "sessions.cancel_pending_input",
  compact: "sessions.compact",
  compactAndContinue: "sessions.compact_and_continue",
  continue: "sessions.continue",
  create: "sessions.create",
  fork: "sessions.fork",
  spawn: "sessions.spawn",
  history: "sessions.history",
  models: "sessions.models",
  previewToolUpdate: "sessions.preview_tool_update",
  read: "sessions.read",
  reassign: "sessions.reassign",
  updateProvider: "sessions.update_provider",
  followUp: "sessions.follow_up",
  send: "sessions.send",
  setAutoCompaction: "sessions.set_auto_compaction",
  setIdleCompaction: "sessions.set_idle_compaction",
  setContextTokenCap: "sessions.set_context_token_cap",
  stop: "sessions.stop",
  steer: "sessions.steer",
  subscribe: "sessions.subscribe",
  updateTools: "sessions.update_tools",
} as const;

export class RealtimeCommandError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.name = "RealtimeCommandError";
    this.code = code;
    this.detail = detail;
  }
}

export type UserRealtimeCommand = Readonly<{
  commandId: string;
  idempotencyKey: string;
  operation: string;
  payload: Readonly<Record<string, unknown>>;
  type: "command";
}>;

const USER_REALTIME_PROTOCOL_ERROR = "UserRealtimeProtocolError" as const;

export interface UserRealtimeProtocolError extends Error {
  readonly commandId: string | undefined;
  readonly name: typeof USER_REALTIME_PROTOCOL_ERROR;
}

const createUserRealtimeProtocolError = (
  message: string,
  commandId?: string,
): UserRealtimeProtocolError =>
  Object.assign(new Error(message), {
    commandId,
    name: USER_REALTIME_PROTOCOL_ERROR,
  });

export const isUserRealtimeProtocolError = (
  value: unknown,
): value is UserRealtimeProtocolError =>
  value instanceof Error && value.name === USER_REALTIME_PROTOCOL_ERROR;

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;
}

export function readUserRealtimeCommand(message: string): UserRealtimeCommand {
  if (utf8ByteLength(message) > MAXIMUM_REALTIME_MESSAGE_BYTES) {
    throw createUserRealtimeProtocolError("The realtime command was too large");
  }

  let value: Readonly<Record<string, unknown>>;
  try {
    value = parseJsonRecord(message, "The realtime command was invalid");
  } catch {
    throw createUserRealtimeProtocolError("The realtime command was invalid");
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
    throw createUserRealtimeProtocolError(
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
