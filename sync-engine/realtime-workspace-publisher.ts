import type { RealtimeHub } from "./realtime-hub.ts";
import { publishWorkspaceSnapshot } from "./realtime-publish.ts";

type SnapshotType = Parameters<typeof publishWorkspaceSnapshot>[3];

export function createWorkspaceSnapshotPublisher(
  hub: RealtimeHub,
  type: SnapshotType,
  read: (userId: string, workspaceId: string) => readonly unknown[],
): (userId: string, workspaceId: string) => void {
  return (userId, workspaceId) => {
    publishWorkspaceSnapshot(
      hub,
      userId,
      workspaceId,
      type,
      read(userId, workspaceId),
    );
  };
}
