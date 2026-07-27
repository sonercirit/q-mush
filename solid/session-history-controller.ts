import {
  SESSION_HISTORY_REALTIME_OPERATION,
  type SessionHistoryPage,
} from "../shared/session-history.ts";
import { readSessionHistoryPage } from "./session-history-codec.ts";
import type { SessionCommandTransport } from "./session-transport.ts";

export async function loadSessionHistoryPage(
  transport: SessionCommandTransport,
  sessionId: string,
  cursor: string | null,
  workspaceId?: string,
): Promise<SessionHistoryPage> {
  const payload: {
    cursor: string | null;
    sessionId: string;
    workspaceId?: string;
  } = { cursor, sessionId };
  if (workspaceId !== undefined) {
    payload.workspaceId = workspaceId;
  }
  return readSessionHistoryPage(
    await transport.command(SESSION_HISTORY_REALTIME_OPERATION, payload),
  );
}
