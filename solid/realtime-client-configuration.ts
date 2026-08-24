import { REALTIME_PATH } from "../shared/routes.ts";
import { GLOBAL_WORKSPACE_ID } from "../shared/workspace-model.ts";
import type { RealtimeServerEvent } from "./realtime-client-codec.ts";

export type DeferredStateEvent = Extract<
  RealtimeServerEvent,
  {
    readonly type:
      | "runners"
      | "session"
      | "session_compaction_request"
      | "session_compaction_settled"
      | "session_questions"
      | "sessions"
      | "sessions_changed"
      | "tool_stream_snapshot";
  }
>;
export const RECONNECT_DELAYS = [250, 500, 1_000, 2_000, 5_000] as const;
export const STREAM_UPDATES_PER_FRAME = 4;
export const STREAM_PREP_BUDGET_MS = 8;
export function deferredStateEventKey<Type extends DeferredStateEvent["type"]>(
  event: Extract<DeferredStateEvent, { readonly type: Type }>,
  expectedType: Type,
  keys: {
    [Kind in DeferredStateEvent["type"]]: (
      matched: Extract<DeferredStateEvent, { readonly type: Kind }>,
    ) => string;
  },
): string {
  return keys[expectedType](event);
}
export function noSelectedSession(): undefined {
  return undefined;
}
export interface RealtimeLocation {
  readonly href: string;
  readonly protocol: string;
}
export function realtimeUrl(
  location: RealtimeLocation,
  workspaceId: string,
): string {
  const url = new URL(REALTIME_PATH, location.href);
  if (workspaceId !== GLOBAL_WORKSPACE_ID)
    url.searchParams.set("workspaceId", workspaceId);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
