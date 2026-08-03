import { and, asc, eq } from "drizzle-orm";
import type { AppDatabase } from "../shared/database.ts";
import { agentMessages } from "../shared/database/schema.ts";
import {
  decodeSessionHistoryCursor,
  encodeSessionHistoryCursor,
  SESSION_HISTORY_PAGE_SIZE,
  type SessionHistoryPage,
  type SessionHistoryRequest,
} from "../shared/session-history.ts";
import { countSelectedRows } from "./database-count.ts";
import { storedActiveSessionState } from "./session-active-query.ts";
import { STORED_SESSION_MESSAGE_SELECTION } from "./session-message-selection.ts";
import { summarizeStoredMessage } from "./session-store-read.ts";
import { storedSegmentTokenUsage } from "./session-token-usage-store.ts";

interface AuthorizedHistorySegment {
  readonly currentSegment: number;
  readonly segment: number;
}

interface HistoryLookup {
  readonly database: Pick<AppDatabase, "select">;
  readonly request: SessionHistoryRequest;
  readonly userId: string;
}

function authorizedHistorySegment({
  database,
  request,
  userId,
}: HistoryLookup): AuthorizedHistorySegment | undefined {
  const stored = storedActiveSessionState(database, request.sessionId, userId);
  if (stored === undefined || stored.currentSegment === 0) {
    return undefined;
  }
  let segment: number;
  if (request.cursor === null) {
    segment = stored.currentSegment - 1;
  } else {
    const decoded = decodeSessionHistoryCursor(request.cursor);
    if (decoded?.sessionId !== request.sessionId) {
      return undefined;
    }
    segment = decoded.segment;
  }
  return segment >= 0 && segment < stored.currentSegment
    ? { currentSegment: stored.currentSegment, segment }
    : undefined;
}

export function readStoredSessionHistory(
  database: Pick<AppDatabase, "select">,
  userId: string,
  request: SessionHistoryRequest,
): SessionHistoryPage | undefined {
  const authorized = authorizedHistorySegment({ database, request, userId });
  if (authorized === undefined) {
    return undefined;
  }
  const decoded =
    request.cursor === null
      ? undefined
      : decodeSessionHistoryCursor(request.cursor);
  const condition = and(
    eq(agentMessages.sessionId, request.sessionId),
    eq(agentMessages.userId, userId),
    eq(agentMessages.segment, authorized.segment),
  );
  const total = countSelectedRows(database, agentMessages, condition);
  const offset =
    decoded?.offset === undefined || decoded.offset === "tail"
      ? Math.max(0, total - SESSION_HISTORY_PAGE_SIZE)
      : decoded.offset;
  if (offset >= Math.max(1, total)) {
    return undefined;
  }
  const messages = database
    .select(STORED_SESSION_MESSAGE_SELECTION)
    .from(agentMessages)
    .where(condition)
    .orderBy(asc(agentMessages.createdAt), asc(agentMessages.id))
    .limit(SESSION_HISTORY_PAGE_SIZE)
    .offset(offset)
    .all()
    .map(summarizeStoredMessage);
  const nextOffset = offset + messages.length;
  return {
    currentSegment: authorized.currentSegment,
    messages,
    newerCursor:
      nextOffset < total
        ? encodeSessionHistoryCursor(
            request.sessionId,
            authorized.segment,
            nextOffset,
          )
        : authorized.segment < authorized.currentSegment - 1
          ? encodeSessionHistoryCursor(
              request.sessionId,
              authorized.segment + 1,
            )
          : null,
    olderCursor:
      offset > 0
        ? encodeSessionHistoryCursor(
            request.sessionId,
            authorized.segment,
            Math.max(0, offset - SESSION_HISTORY_PAGE_SIZE),
          )
        : authorized.segment > 0
          ? encodeSessionHistoryCursor(
              request.sessionId,
              authorized.segment - 1,
            )
          : null,
    segment: authorized.segment,
    sessionId: request.sessionId,
    tokenUsage: storedSegmentTokenUsage(
      database,
      request.sessionId,
      authorized.segment,
    ),
  };
}
