import type { RealtimeConnection } from "./realtime-client.ts";

export type SessionCommandTransport = Pick<RealtimeConnection, "command"> & {
  onReconnect?(listener: () => void): () => void;
};
