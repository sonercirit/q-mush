import { RealtimeConnection } from "../../solid/realtime-client.ts";
import type { RealtimeClientEvent } from "../../solid/realtime-stream-buffer.ts";
import {
  createRealtimeTestSocket,
  type RealtimeTestSocket,
} from "./realtime-client-fixtures.ts";

const LOCATION = {
  href: "https://qmush.example/app",
  protocol: "https:",
};

interface RealtimeTestSetupOptions {
  readonly listener?: (event: RealtimeClientEvent) => void;
  readonly now?: () => number;
  readonly requestFrame?: (callback: () => void) => number;
  readonly selectedSession?: () => string | undefined;
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
        const socket = createRealtimeTestSocket(url);
        sockets.push(socket);
        return socket;
      },
      location: LOCATION,
      ...(options.now === undefined ? {} : { now: options.now }),
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
      ...(options.selectedSession === undefined
        ? {}
        : { selectedSession: options.selectedSession }),
    },
  );
  connection.start();
  return { connection, requestFrames, sockets, timers };
}
