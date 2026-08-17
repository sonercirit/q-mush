import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import type { RealtimeClientEvent } from "../realtime-stream-buffer.ts";
import { realtimeTestSetup } from "./realtime-client-test-setup.ts";

export interface StreamingRealtimeFixture {
  readonly emitted: RealtimeClientEvent[];
  readonly pendingFrames: (() => void)[];
  readonly receive: (event: RealtimeServerEvent) => void;
  readonly stop: () => void;
}

export function streamingRealtimeFixture(
  instanceId: string,
  listener?: (event: RealtimeClientEvent) => void,
): StreamingRealtimeFixture {
  const emitted: RealtimeClientEvent[] = [];
  const setup = realtimeTestSetup({
    listener(event) {
      emitted.push(event);
      listener?.(event);
    },
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
  const stop = (): void => {
    const connection = setup.connection;
    connection.stop();
  };
  return {
    emitted,
    pendingFrames: setup.requestFrames,
    receive,
    stop,
  };
}
