import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { RealtimeClientEvent } from "../realtime-stream-buffer.ts";
import type { RealtimeTestSocket } from "./realtime-client-fixtures.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";

export interface StreamingRealtimeFixture {
  readonly emitted: RealtimeClientEvent[];
  readonly pendingFrames: (() => void)[];
  readonly receive: (event: RealtimeServerEvent) => void;
  readonly reconnect: (instanceId: string) => RealtimeTestSocket;
  readonly setup: ReturnType<typeof realtimeTestSetup>;
  readonly stop: () => void;
}

export interface StreamingRealtimeFixtureOptions {
  readonly now?: () => number;
  readonly selectedSession?: () => string | undefined;
}

export function streamingRealtimeFixture(
  instanceId: string,
  listener?: (event: RealtimeClientEvent) => void,
  options: StreamingRealtimeFixtureOptions = {},
): StreamingRealtimeFixture {
  const emitted: RealtimeClientEvent[] = [];
  const setup = realtimeTestSetup({
    listener(event) {
      emitted.push(event);
      listener?.(event);
    },
    ...options,
  });
  const sockets = setup.sockets;
  const socket = sockets[0];
  if (socket === undefined) {
    throw new TypeError("Missing streaming fixture socket");
  }
  socket.open(instanceId);
  emitted.length = 0;
  const receive = (event: RealtimeServerEvent): void => {
    socket.receive(event);
  };
  const reconnect = (reconnectedInstanceId: string): RealtimeTestSocket => {
    setup.sockets.at(-1)?.close();
    setup.timers.shift()?.();
    const reconnected = setup.sockets.at(-1);
    if (reconnected === undefined) {
      throw new TypeError("Missing reconnected fixture socket");
    }
    reconnected.open(reconnectedInstanceId);
    return reconnected;
  };
  const stop = (): void => {
    const connection = setup.connection;
    connection.stop();
  };
  return {
    emitted,
    pendingFrames: setup.requestFrames,
    receive,
    reconnect,
    setup,
    stop,
  };
}
