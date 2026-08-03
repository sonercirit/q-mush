import { AGENT_SESSION_TOOL_NAMES } from "../../shared/agent-tools.ts";
import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";

export function createSessionRealtimeCommandPayload() {
  return {
    credentialId: "credential-1",
    executionEnvironment: "bare_metal" as const,
    model: "model-1",
    prompt: "Create the session",
    provider: "openai" as const,
    runnerId: "runner-1",
    tools: AGENT_SESSION_TOOL_NAMES,
    workingDirectory: "/work/project",
  };
}

export function userRealtimeCommand(
  operation: string,
  payload: Readonly<Record<string, unknown>>,
  identifiers: Readonly<{
    readonly commandId?: string;
    readonly idempotencyKey?: string;
  }> = {},
): UserRealtimeCommand {
  return {
    commandId: identifiers.commandId ?? "command-1",
    idempotencyKey: identifiers.idempotencyKey ?? "mutation-1",
    operation,
    payload,
    type: "command",
  };
}
