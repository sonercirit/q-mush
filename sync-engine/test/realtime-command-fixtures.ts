import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";

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
