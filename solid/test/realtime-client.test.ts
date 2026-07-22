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
  expect(sockets[0]?.sent).toEqual(['{"type":"refresh"}']);
  expect(events).toEqual([{ sessions: [], type: "sessions" }]);
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
