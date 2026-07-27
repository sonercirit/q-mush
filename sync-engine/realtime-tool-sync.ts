import { isRecord } from "../shared/auth-model.ts";
import { MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH } from "../shared/tool-stream.ts";
import type { UserRealtimeProtocolError } from "../shared/user-realtime-protocol.ts";

import { utf8ByteLength } from "../shared/utf8.ts";
import type { RealtimeHub, RealtimeSocket } from "./realtime-hub.ts";
import { closeServerError, safeSend } from "./realtime-runner-runtime.ts";

interface ToolStreamSyncSessions {
  detailForUser(
    userId: string,
    sessionId: string,
    workspaceId?: string,
  ): unknown;
}

function isBoundedIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  return utf8ByteLength(value) <= MAXIMUM_TOOL_STREAM_IDENTIFIER_LENGTH;
}

export function sendCommandError(
  socket: RealtimeSocket,
  commandId: string,
  error: string,
): void {
  if (
    !safeSend(
      socket,
      JSON.stringify({ commandId, error, type: "command_error" }),
    )
  ) {
    closeServerError(socket, "Realtime acknowledgement failed");
  }
}

/**
 * Handles the non-command tool snapshot request after the socket user has been
 * revalidated. Other payloads return false so the command protocol can report
 * its own correlated errors.
 */
export function handleToolStreamSync(options: {
  readonly commandError: UserRealtimeProtocolError;
  readonly hub: RealtimeHub;
  readonly message: string;
  readonly sessions: ToolStreamSyncSessions;
  readonly socket: RealtimeSocket;
  readonly userId: string;
  readonly workspaceId: string;
}): boolean {
  let value: unknown;
  try {
    value = JSON.parse(options.message);
  } catch {
    return false;
  }
  if (
    options.commandError.commandId !== undefined ||
    !isRecord(value) ||
    value["type"] !== "sync_tools"
  ) {
    return false;
  }

  const sessionId = value["sessionId"];
  const streamId = value["streamId"];
  if (
    Object.keys(value).length !== 3 ||
    !isBoundedIdentifier(sessionId) ||
    !isBoundedIdentifier(streamId)
  ) {
    throw new Error("The tool stream synchronization request was invalid");
  }
  if (
    options.sessions.detailForUser(
      options.userId,
      sessionId,
      options.workspaceId,
    ) === undefined
  ) {
    throw new Error("The tool stream session was not found");
  }
  options.hub.syncToolStreams(
    options.userId,
    sessionId,
    streamId,
    options.socket,
  );
  return true;
}
