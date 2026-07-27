import { isRecord } from "./auth-model.ts";
import type { AgentSessionMessage } from "./session-model.ts";

export const SESSION_HISTORY_PAGE_SIZE = 100;
export const SESSION_HISTORY_REALTIME_OPERATION = "sessions.history";

export interface SessionHistoryPage {
  readonly currentSegment: number;
  readonly messages: readonly AgentSessionMessage[];
  readonly newerCursor: string | null;
  readonly olderCursor: string | null;
  readonly segment: number;
  readonly sessionId: string;
}

export interface SessionHistoryRequest {
  readonly cursor: string | null;
  readonly sessionId: string;
}

interface SessionHistoryCursorValue {
  readonly offset: number | "tail";
  readonly segment: number;
  readonly sessionId: string;
  readonly version: 1;
}

const CURSOR_PATTERN = /^[A-Za-z\d_-]{1,400}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z\d._:-]{1,200}$/u;

function cursorValue(value: unknown): SessionHistoryCursorValue | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const offset = value["offset"];
  const segment = value["segment"];
  const sessionId = value["sessionId"];
  return value["version"] === 1 &&
    (offset === "tail" ||
      (typeof offset === "number" &&
        Number.isSafeInteger(offset) &&
        offset >= 0)) &&
    typeof segment === "number" &&
    Number.isSafeInteger(segment) &&
    segment >= 0 &&
    typeof sessionId === "string" &&
    SESSION_ID_PATTERN.test(sessionId) &&
    Object.keys(value).length === 4
    ? { offset, segment, sessionId, version: 1 }
    : undefined;
}

export function encodeSessionHistoryCursor(
  sessionId: string,
  segment: number,
  offset: number | "tail" = "tail",
): string {
  const value: SessionHistoryCursorValue = {
    offset,
    segment,
    sessionId,
    version: 1,
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeSessionHistoryCursor(
  cursor: string,
): SessionHistoryCursorValue | undefined {
  if (!CURSOR_PATTERN.test(cursor)) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) {
      return undefined;
    }
    return cursorValue(JSON.parse(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

export function readSessionHistoryRequest(
  payload: Readonly<Record<string, unknown>>,
): SessionHistoryRequest | undefined {
  const cursor = payload["cursor"];
  const sessionId = payload["sessionId"];
  return typeof sessionId === "string" &&
    SESSION_ID_PATTERN.test(sessionId) &&
    (cursor === null ||
      (typeof cursor === "string" && CURSOR_PATTERN.test(cursor))) &&
    Object.keys(payload).every(
      (key) => key === "cursor" || key === "sessionId" || key === "workspaceId",
    )
    ? { cursor, sessionId }
    : undefined;
}
