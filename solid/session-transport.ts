import type { RealtimeConnection } from "./realtime-client.ts";

export type SessionCommandTransport = Pick<RealtimeConnection, "command"> & {
  onReconnect?(listener: () => void): () => void;
};

/** @public Starts realtime before an initial load and rolls back on failure. */
export function startRealtimeSessionLoad(
  realtime: Pick<RealtimeConnection, "start" | "stop">,
  load: () => Promise<unknown>,
): Promise<unknown> {
  realtime.start();
  return load().catch((error: unknown) => {
    realtime.stop();
    throw error;
  });
}
