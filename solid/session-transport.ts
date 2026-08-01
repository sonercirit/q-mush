import type { RealtimeConnection } from "./realtime-client.ts";

export type SessionCommandTransport = Pick<RealtimeConnection, "command"> & {
  onReconnect?(listener: () => void): () => void;
  yieldToStateApplication?(): Promise<boolean>;
};

/** @public Starts realtime before an initial load and rolls back on failure. */
export function startRealtimeSessionLoad(
  realtime: Pick<RealtimeConnection, "start" | "stop">,
  workspaceId: string,
  load: () => Promise<unknown>,
): Promise<unknown> {
  realtime.start(workspaceId);
  return load().catch((error: unknown) => {
    realtime.stop();
    throw error;
  });
}
