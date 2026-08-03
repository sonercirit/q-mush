import type { AgentSessionDetail } from "../shared/session-model.ts";
import {
  setStoredSessionAutoCompact,
  type SessionSettingContext,
} from "./session-auto-compact-store.ts";
import { updateStoredSessionContextTokenCap } from "./session-context-limit-store.ts";

export type SessionContextTokenCapParameters = readonly [
  userId: string,
  sessionId: string,
  cap: number | null,
  now: number,
  workspaceId?: string,
];

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

export type SessionAutoCompactParameters = readonly [
  userId: string,
  sessionId: string,
  autoCompact: boolean,
  now: number,
  workspaceId?: string,
];

export function setSessionAutoCompact(
  context: SessionSettingContext,
  ...parameters: SessionAutoCompactParameters
): AgentSessionDetail | undefined {
  return setStoredSessionAutoCompact(context, ...parameters);
}
