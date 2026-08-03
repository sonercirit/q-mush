import type { AppDatabase } from "../shared/database.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import { setStoredSessionAutoCompact } from "./session-auto-compact-store.ts";
import { updateStoredSessionContextTokenCap } from "./session-context-limit-store.ts";

export type SessionContextTokenCapParameters = readonly [
  userId: string,
  sessionId: string,
  cap: number | null,
  now: number,
  workspaceId?: string,
];

export type SessionReader = (
  userId: string,
  sessionId: string,
  workspaceId?: string,
) => AgentSessionDetail | undefined;

export function setSessionContextTokenCap(
  database: AppDatabase,
  read: SessionReader,
  ...[
    userId,
    sessionId,
    cap,
    now,
    workspaceId,
  ]: SessionContextTokenCapParameters
): AgentSessionDetail | undefined {
  return updateStoredSessionContextTokenCap({
    database,
    now,
    read,
    sessionId,
    userContextTokenCap: cap,
    userId,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
}

export type SessionAutoCompactParameters = readonly [
  userId: string,
  sessionId: string,
  autoCompact: boolean,
  now: number,
  workspaceId?: string,
];

export function setSessionAutoCompact(
  database: AppDatabase,
  read: SessionReader,
  ...[
    userId,
    sessionId,
    autoCompact,
    now,
    workspaceId,
  ]: SessionAutoCompactParameters
): AgentSessionDetail | undefined {
  return setStoredSessionAutoCompact(
    database,
    read,
    userId,
    sessionId,
    autoCompact,
    now,
    workspaceId,
  );
}
