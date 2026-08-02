import type { AgentSessionMessage } from "../shared/session-model.ts";
import { requireRecord } from "../shared/validation.ts";

export function readMessageRecord(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  return requireRecord(value, message);
}

export function sessionMessageRole(
  value: unknown,
): AgentSessionMessage["role"] | undefined {
  switch (value) {
    case "assistant":
    case "compaction_request":
    case "error":
    case "system":
    case "thinking":
    case "tool":
    case "user":
      return value;
    default:
      return undefined;
  }
}
