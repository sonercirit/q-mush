export interface RealtimeTestSocket extends EventTarget {
  throwAfter: number | undefined;
  readonly sent: string[];
  readonly url: string | undefined;
  readonly readyState: number;
  readonly close: () => void;
  readonly open: (instanceId?: string) => void;
  readonly receive: (value: unknown) => void;
  readonly send: (message: string) => void;
}

export function createRealtimeTestSocket(url?: string): RealtimeTestSocket {
  let closed = false;
  let opened = false;
  const events = new EventTarget();
  const socket: RealtimeTestSocket = {
    addEventListener: (...arguments_) => {
      events.addEventListener(...arguments_);
    },
    close: () => {
      if (closed) return;
      closed = true;
      socket.dispatchEvent(new Event("close"));
    },
    dispatchEvent: (event) => events.dispatchEvent(event),
    open: (instanceId) => {
      opened = true;
      socket.dispatchEvent(new Event("open"));
      if (instanceId !== undefined) {
        socket.receive({ instanceId, type: "ready" });
      }
    },
    receive: (value) => {
      const data = typeof value === "string" ? value : JSON.stringify(value);
      socket.dispatchEvent(new MessageEvent("message", { data }));
    },
    removeEventListener: (...arguments_) => {
      events.removeEventListener(...arguments_);
    },
    send: (message) => {
      const shouldFail =
        socket.throwAfter !== undefined &&
        socket.sent.length >= socket.throwAfter;
      if (shouldFail) throw new Error("realtime fixture send failure");
      socket.sent.push(message);
    },
    sent: [],
    throwAfter: undefined,
    url,
    get readyState() {
      if (closed) return WebSocket.CLOSED;
      return opened ? WebSocket.OPEN : WebSocket.CONNECTING;
    },
  };
  return socket;
}
