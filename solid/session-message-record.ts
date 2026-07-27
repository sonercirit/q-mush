import { isRecord } from "../shared/auth-model.ts";
import type { AgentSessionMessage } from "../shared/session-model.ts";

export function readMessageRecord(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

export function sessionMessageRole(
  value: unknown,
): AgentSessionMessage["role"] | undefined {
  switch (value) {
    case "assistant":
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
