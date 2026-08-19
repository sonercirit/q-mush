import {
  MAXIMUM_TOOL_STREAMS_PER_SESSION,
  MAXIMUM_TOOL_STREAMS_PER_USER,
} from "../shared/tool-stream.ts";

export interface ToolSnapshotRequest {
  readonly sessionId: string;
  readonly streamId: string;
}

function requestKey(sessionId: string, streamId: string): string {
  return JSON.stringify([sessionId, streamId]);
}

export function rememberToolSnapshot(
  snapshots: Map<string, ToolSnapshotRequest>,
  sessionId: string,
  streamId: string | undefined,
): void {
  if (streamId === undefined) return;
  const key = requestKey(sessionId, streamId);
  snapshots.delete(key);
  snapshots.set(key, { sessionId, streamId });
  let sessionRequests = 0;
  for (const request of snapshots.values()) {
    if (request.sessionId === sessionId) sessionRequests += 1;
  }
  while (sessionRequests > MAXIMUM_TOOL_STREAMS_PER_SESSION) {
    for (const [candidateKey, request] of snapshots) {
      if (request.sessionId !== sessionId) continue;
      snapshots.delete(candidateKey);
      sessionRequests -= 1;
      break;
    }
  }
  while (snapshots.size > MAXIMUM_TOOL_STREAMS_PER_USER) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}
