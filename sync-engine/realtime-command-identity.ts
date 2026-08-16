import { sha256Base64Url } from "../shared/sha256.ts";
import type { UserRealtimeCommand } from "../shared/user-realtime-protocol.ts";
import { utf8ByteLength } from "../shared/utf8.ts";

export function scopedCommandIdentity(
  workspaceId: string,
  identifier: string,
): string {
  return JSON.stringify([workspaceId, identifier]);
}

export function commandFingerprint(
  command: UserRealtimeCommand,
): string | undefined {
  try {
    const serialized = JSON.stringify({
      operation: command.operation,
      payload: command.payload,
    });
    if (typeof serialized !== "string") {
      return undefined;
    }
    return sha256Base64Url(serialized);
  } catch {
    return undefined;
  }
}

export function commandPayloadBytes(command: UserRealtimeCommand): number {
  try {
    const serialized = JSON.stringify(command.payload);
    return typeof serialized === "string"
      ? utf8ByteLength(serialized)
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
