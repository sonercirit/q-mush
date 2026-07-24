import type { UserRealtimeCommand } from "../../shared/user-realtime-protocol.ts";

export function userRealtimeCommand(
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): UserRealtimeCommand {
  return {
    commandId: "command-1",
    idempotencyKey: "mutation-1",
    operation,
    payload,
    type: "command",
  };
}
