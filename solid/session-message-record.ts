import type { AgentSessionMessage } from "../shared/session-model.ts";
import { requireRecord } from "../shared/validation.ts";

export function readMessageRecord(
  value: unknown,
  message: string,
): Readonly<Record<string, unknown>> {
  return requireRecord(value, message);
}

const MESSAGE_ROLES: Record<AgentSessionMessage["role"], true> = {
  assistant: true,
  compaction_request: true,
  error: true,
  system: true,
  thinking: true,
  tool: true,
  user: true,
};

function isSessionMessageRole(
  value: unknown,
): value is AgentSessionMessage["role"] {
  return typeof value === "string" && Object.hasOwn(MESSAGE_ROLES, value);
}

export function sessionMessageRole(
  value: unknown,
): AgentSessionMessage["role"] | undefined {
  return isSessionMessageRole(value) ? value : undefined;
}
