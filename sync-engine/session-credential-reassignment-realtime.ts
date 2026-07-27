import type { RealtimeHub } from "./realtime-hub.ts";

export function createSessionsChangedPublisher(
  realtime: Pick<RealtimeHub, "publishUser" | "userWorkspaces">,
): (userId: string) => void {
  return (userId) => {
    for (const workspaceId of realtime.userWorkspaces(userId)) {
      realtime.publishUser(userId, { type: "sessions_changed" }, workspaceId);
    }
    realtime.publishUser(userId, { type: "sessions_changed" });
  };
}
