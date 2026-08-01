import type { RealtimeServerEvent } from "../../solid/realtime-client-codec.ts";
import { RealtimeConnection } from "../../solid/realtime-client.ts";
import { RealtimeTestSocket } from "./realtime-client-fixtures.ts";

const LOCATION = {
  href: "https://qmush.example/app",
  protocol: "https:",
};

interface RealtimeTestSetupOptions {
  readonly listener?: (event: RealtimeServerEvent) => void;
  readonly requestFrame?: (callback: () => void) => number;
}

interface RealtimeTestSetup {
  readonly connection: RealtimeConnection;
  readonly requestFrames: (() => void)[];
  readonly sockets: RealtimeTestSocket[];
  readonly timers: (() => void)[];
}

export function realtimeTestSetup(
  options: RealtimeTestSetupOptions = {},
): RealtimeTestSetup {
  const requestFrames: (() => void)[] = [];
  const sockets: RealtimeTestSocket[] = [];
  const timers: (() => void)[] = [];
  const connection = new RealtimeConnection(
    options.listener ?? (() => undefined),
    {
      clearTimeout: () => undefined,
      createSocket: (url) => {
        const socket = new RealtimeTestSocket(url);
        sockets.push(socket);
        return socket;
      },
      location: LOCATION,
      requestFrame:
        options.requestFrame ??
        ((callback) => {
          requestFrames.push(callback);
          return requestFrames.length;
        }),
      setTimeout: (callback) => {
        timers.push(callback);
        return timers.length;
      },
    },
  );
  connection.start();
  return { connection, requestFrames, sockets, timers };
}
