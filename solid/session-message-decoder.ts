import type { AgentSessionMessage } from "../shared/session-model.ts";
import { readSessionMessageFields } from "./session-message-codec.ts";
import {
  readMessageRecord,
  sessionMessageRole,
} from "./session-message-record.ts";

export function decodedSessionMessage(
  value: unknown,
  invalidMessage: string,
): Readonly<{
  readonly fields: Omit<AgentSessionMessage, "role" | "toolCalls">;
  readonly record: Readonly<Record<string, unknown>>;
  readonly role: AgentSessionMessage["role"];
}> {
  const record = readMessageRecord(value, invalidMessage);
  const fields = readSessionMessageFields(record);
  const role = sessionMessageRole(record["role"]);
  if (fields === undefined || role === undefined) {
    throw new Error(invalidMessage);
  }
  return { fields, record, role };
}
