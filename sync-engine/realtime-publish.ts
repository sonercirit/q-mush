import type { RealtimeHub } from "./realtime-hub.ts";

export function publishWorkspaceSnapshot(
  hub: RealtimeHub,
  userId: string,
  workspaceId: string,
  type: "runners" | "sessions",
  values: readonly unknown[],
): void {
  hub.publishUser(userId, { [type]: values, type }, workspaceId);
}
