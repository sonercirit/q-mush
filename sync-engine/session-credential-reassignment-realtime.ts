import type { RealtimeHub } from "./realtime-hub.ts";

export function createSessionsChangedPublisher(
  realtime: Pick<RealtimeHub, "publishUser">,
): (userId: string) => void {
  return (userId) => {
    realtime.publishUser(userId, { type: "sessions_changed" });
  };
}
