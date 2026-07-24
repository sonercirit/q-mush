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

function createTestConnection(
  sockets: BrowserSocket[],
  listener: ConstructorParameters<typeof RealtimeConnection>[0] = () =>
    undefined,
  options: ConstructorParameters<typeof RealtimeConnection>[1] = {},
): RealtimeConnection {
  return new RealtimeConnection(listener, {
    ...connectionOptions(sockets),
    ...options,
  });
}

function scheduledConnection(
  sockets: BrowserSocket[],
  timers: (() => void)[],
  onConnectionChange?: (state: string) => void,
): RealtimeConnection {
  return createTestConnection(sockets, undefined, {
    ...(onConnectionChange === undefined ? {} : { onConnectionChange }),
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });
}

interface ReconnectTest {
  readonly connection: RealtimeConnection;
  readonly sockets: BrowserSocket[];
  readonly timers: (() => void)[];
}

function reconnectTest(
  onConnectionChange?: (state: string) => void,
): ReconnectTest {
  const sockets: BrowserSocket[] = [];
  const timers: (() => void)[] = [];
  return {
    connection: scheduledConnection(sockets, timers, onConnectionChange),
    sockets,
    timers,
  };
}

function beginReconnect(
  connection: RealtimeConnection,
  sockets: BrowserSocket[],
): void {
  connection.start();
  sockets[0]?.close();
}

function reconnect(sockets: BrowserSocket[], timers: (() => void)[]): void {
  timers.shift()?.();
  sockets[1]?.dispatchEvent(new Event("open"));
}

test("connects to the same-origin realtime WebSocket and decodes events", () => {
  const sockets: BrowserSocket[] = [];
  const events: unknown[] = [];
  const connection = createTestConnection(
    sockets,
    (event) => events.push(event),
    { setTimeout: () => 1 },
  );

  connection.start();
  sockets[0]?.dispatchEvent(new Event("open"));
  sockets[0]?.receive('{"sessions":[],"type":"sessions"}');

  expect(sockets[0]?.url).toBe("wss://qmush.example/api/realtime");
  expect(sockets[0]?.sent).toEqual(['{"type":"refresh"}']);
  expect(events).toEqual([{ sessions: [], type: "sessions" }]);
  connection.stop();
});

test("reports connection lifecycle around reconnect snapshots", () => {
  const connectionStates: string[] = [];
  const { connection, sockets, timers } = reconnectTest((state) =>
    connectionStates.push(state),
  );

  connection.start();
  expect(connectionStates).toEqual(["connecting"]);
  sockets[0]?.dispatchEvent(new Event("open"));
  expect(connectionStates).toEqual(["connecting", "connected"]);

  sockets[0]?.close();
  expect(connectionStates).toEqual(["connecting", "connected", "disconnected"]);
  reconnect(sockets, timers);
  expect(connectionStates.at(-1)).toBe("connected");

  connection.stop();
  expect(connectionStates.at(-1)).toBe("stopped");
});

test("reconnects after a close and stops retrying after stop", () => {
  const { connection, sockets, timers } = reconnectTest();

  beginReconnect(connection, sockets);
  expect(timers).toHaveLength(1);
  reconnect(sockets, timers);
  expect(sockets).toHaveLength(2);
  connection.stop();
  sockets[1]?.dispatchEvent(new Event("close"));
  expect(timers).toHaveLength(0);
});
