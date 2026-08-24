import type { AppDatabase } from "../shared/database.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  setStoredSessionCompactionFlag,
  type SessionCompactionFlagParameters,
  type SessionSettingContext,
} from "./session-auto-compact-store.ts";
import { updateStoredSessionContextTokenCap } from "./session-context-limit-store.ts";

export type { SessionCompactionFlagParameters } from "./session-auto-compact-store.ts";

export type SessionContextTokenCapParameters = readonly [
  userId: string,
  sessionId: string,
  cap: number | null,
  now: number,
  workspaceId?: string,
];

export function createSessionSettingContext(
  database: AppDatabase,
  read: SessionSettingContext["read"],
): SessionSettingContext {
  return { database, read };
}

export function setSessionContextTokenCap(
  context: SessionSettingContext,
  ...[
    userId,
    sessionId,
    cap,
    now,
    workspaceId,
  ]: SessionContextTokenCapParameters
): AgentSessionDetail | undefined {
  const values = {
    database: context.database,
    now,
    read: context.read,
    sessionId,
    userContextTokenCap: cap,
    userId,
  };
  return updateStoredSessionContextTokenCap(
    workspaceId === undefined ? values : { ...values, workspaceId },
  );
}

export function setSessionCompactionFlag(
  context: SessionSettingContext,
  flag: "autoCompact" | "idleCompact",
  ...parameters: SessionCompactionFlagParameters
): AgentSessionDetail | undefined {
  return setStoredSessionCompactionFlag(context, flag, ...parameters);
}
