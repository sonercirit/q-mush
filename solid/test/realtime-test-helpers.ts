import type { RealtimeServerEvent } from "../realtime-client-codec.ts";
import { RealtimeConnection } from "../realtime-client.ts";

class RealtimeReceivingSocket extends EventTarget {
  readonly readyState = WebSocket.OPEN;

  close(): void {
    this.dispatchEvent(new Event("close"));
  }

  send(): void {
    // No client output is relevant to realtime coalescing tests.
  }

  receive(event: unknown): void {
    const json = JSON.stringify(event);
    this.dispatchEvent(new MessageEvent("message", { data: json }));
  }
}

export interface RealtimeTestRig {
  readonly connection: RealtimeConnection;
  readonly events: RealtimeServerEvent[];
  readonly frames: (() => void)[];
  readonly socket: RealtimeReceivingSocket;
}

export function realtimeTestRig(
  compactionSnapshot: () => void = () => undefined,
): RealtimeTestRig {
  const events: RealtimeServerEvent[] = [];
  const frames: (() => void)[] = [];
  const socket = new RealtimeReceivingSocket();
  const connection = realtimeTestConnection(
    socket,
    events,
    frames,
    compactionSnapshot,
  );
  connection.start();
  return { connection, events, frames, socket };
}

function realtimeTestConnection(
  socket: RealtimeReceivingSocket,
  events: RealtimeServerEvent[],
  frames: (() => void)[],
  compactionSnapshot: () => void = () => undefined,
): RealtimeConnection {
  const collect = (event: RealtimeServerEvent): void => {
    events.push(event);
  };
  const nextFrame = (callback: () => void): number => {
    frames.push(callback);
    return frames.length;
  };
  return new RealtimeConnection(collect, {
    clearTimeout: () => undefined,
    compactionSnapshot,
    createSocket: () => socket,
    location: { href: "https://qmush.example/app", protocol: "https:" },
    requestFrame: nextFrame,
    setTimeout: () => 1,
  });
}
