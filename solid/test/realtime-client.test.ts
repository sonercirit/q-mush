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
const REFRESH_MESSAGE = '{"type":"refresh"}';

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

function connect(sockets: BrowserSocket[]): RealtimeConnection {
  return new RealtimeConnection(() => undefined, {
    ...connectionOptions(sockets),
    setTimeout: () => 1,
  });
}

test("connects to the same-origin realtime WebSocket and decodes events", () => {
  const sockets: BrowserSocket[] = [];
  const events: unknown[] = [];
  const connection = new RealtimeConnection((event) => events.push(event), {
    ...connectionOptions(sockets),
    setTimeout: () => 1,
  });

  connection.start();
  sockets[0]?.dispatchEvent(new Event("open"));
  sockets[0]?.receive('{"sessions":[],"type":"sessions"}');

  expect(sockets[0]?.url).toBe("wss://qmush.example/api/realtime");
  expect(sockets[0]?.sent).toEqual([REFRESH_MESSAGE]);
  expect(events).toEqual([{ sessions: [], type: "sessions" }]);
  connection.stop();
});

test("refreshes an existing open socket without creating a duplicate", () => {
  const sockets: BrowserSocket[] = [];
  const connection = connect(sockets);

  connection.start();
  const socket = sockets[0];
  socket?.dispatchEvent(new Event("open"));
  if (socket !== undefined) {
    Object.defineProperty(socket, "readyState", { value: WebSocket.OPEN });
  }
  connection.refresh();

  expect(sockets).toHaveLength(1);
  expect(socket?.sent).toEqual([REFRESH_MESSAGE, REFRESH_MESSAGE]);
  connection.stop();
});
test("reconnects after a close and stops retrying after stop", () => {
  const sockets: BrowserSocket[] = [];
  const timers: (() => void)[] = [];
  const connection = new RealtimeConnection(() => undefined, {
    ...connectionOptions(sockets),
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
  });

  connection.start();
  sockets[0]?.close();
  expect(timers).toHaveLength(1);
  timers.shift()?.();
  expect(sockets).toHaveLength(2);

  connection.stop();
  sockets[1]?.dispatchEvent(new Event("close"));
  expect(timers).toHaveLength(0);
});
