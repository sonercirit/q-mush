import { expect, test } from "vitest";
import { RealtimeConnection } from "../../solid/realtime-client.ts";

class BrowserSocket extends EventTarget {
  closed = false;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  get readyState(): number {
    return this.closed ? WebSocket.CLOSED : WebSocket.CONNECTING;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
  }

  transmit(data: string): void {
    this.sent.push(data);
  }

  send = this.transmit.bind(this);

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const LOCATION = {
  href: "https://qmush.example/app",
  protocol: "https:",
};

function socketFactory(sockets: BrowserSocket[]) {
  return (url: string): BrowserSocket => {
    const socket = new BrowserSocket(url);
    sockets.push(socket);
    return socket;
  };
}

function connectionOptions(sockets: BrowserSocket[]) {
  return {
    clearTimeout: () => undefined,
    createSocket: socketFactory(sockets),
    location: LOCATION,
  };
}

function startConnection(
  listener: ConstructorParameters<typeof RealtimeConnection>[0],
  sockets: BrowserSocket[],
  setTimeout: (callback: () => void, delay: number) => number,
): RealtimeConnection {
  const connection = new RealtimeConnection(listener, {
    ...connectionOptions(sockets),
    setTimeout,
  });
  connection.start();
  return connection;
}

function connectionWithTimers(
  listener: ConstructorParameters<typeof RealtimeConnection>[0],
  sockets: BrowserSocket[],
  timers: (() => void)[],
): RealtimeConnection {
  return startConnection(listener, sockets, (callback) => {
    timers.push(callback);
    return timers.length;
  });
}

function openSocket(socket: BrowserSocket | undefined): void {
  socket?.dispatchEvent(new Event("open"));
}

function toolStreamMessage(): string {
  return JSON.stringify({
    callId: "call-1",
    index: 0,
    sequence: 0,
    sessionId: "session-1",
    state: "running",
    streamId: "turn-1",
    type: "tool_stream",
  });
}

function reconnectState(): {
  readonly sockets: BrowserSocket[];
  readonly timers: (() => void)[];
} {
  return { sockets: [], timers: [] };
}

function reconnect(sockets: BrowserSocket[], timers: (() => void)[]): void {
  sockets[0]?.close();
  timers.shift()?.();
}

test("connects to the same-origin realtime WebSocket and decodes events", () => {
  const sockets: BrowserSocket[] = [];
  const events: unknown[] = [];
  const connection = startConnection(
    (event) => events.push(event),
    sockets,
    () => 1,
  );

  openSocket(sockets[0]);
  sockets[0]?.receive('{"sessions":[],"type":"sessions"}');

  expect(sockets[0]?.url).toBe("wss://qmush.example/api/realtime");
  expect(sockets[0]?.sent).toEqual(['{"type":"refresh"}']);
  expect(events).toEqual([{ sessions: [], type: "sessions" }]);
  connection.stop();
});

test("replays the active tool snapshot after reconnect", () => {
  const received = new Set<unknown>();
  const { sockets, timers } = reconnectState();
  const connection = connectionWithTimers(
    (event) => received.add(event),
    sockets,
    timers,
  );

  openSocket(sockets[0]);
  sockets[0]?.receive(toolStreamMessage());
  reconnect(sockets, timers);
  const second = sockets.at(1);
  openSocket(second);

  expect(second?.sent).toEqual([
    '{"type":"refresh"}',
    '{"sessionId":"session-1","streamId":"turn-1","type":"sync_tools"}',
  ]);
  expect(received.size).toBe(0);
  connection.stop();
});

test("reconnects after a close and stops retrying after stop", () => {
  const { sockets, timers } = reconnectState();
  const connection = connectionWithTimers(() => undefined, sockets, timers);
  reconnect(sockets, timers);
  expect(sockets).toHaveLength(2);

  connection.stop();
  sockets.at(-1)?.dispatchEvent(new Event("close"));
  expect(timers).toHaveLength(0);
});
