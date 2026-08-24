export interface RecordingTestSocket extends EventTarget {
  readyState: number;
  readonly sent: string[];
  throwOnSend: boolean;
  close(code?: number, reason?: string): void;
  receive(message: unknown): void;
  send(message: string): void;
}

export interface RecordingTestSocketOptions {
  readonly closeEvent?: () => Event;
  readonly readyState?: number;
}

export function recordingSleep(
  delays: number[],
): (milliseconds: number) => Promise<void> {
  return (milliseconds) => {
    delays.push(milliseconds);
    return Promise.resolve();
  };
}

export function createRecordingTestSocket(
  options: RecordingTestSocketOptions = {},
): RecordingTestSocket {
  const socket = new EventTarget();
  const sent: string[] = [];
  let readyState = options.readyState ?? WebSocket.OPEN;
  let throwOnSend = false;
  const closeEvent = options.closeEvent ?? (() => new Event("close"));

  const state = {
    get readyState(): number {
      return readyState;
    },
    set readyState(value: number) {
      readyState = value;
    },
    get throwOnSend(): boolean {
      return throwOnSend;
    },
    set throwOnSend(value: boolean) {
      throwOnSend = value;
    },
  };
  const result = Object.assign(socket, state, {
    close(): void {
      readyState = WebSocket.CLOSED;
      socket.dispatchEvent(closeEvent());
    },
    receive(message: unknown): void {
      socket.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(message) }),
      );
    },
    send(message: string): void {
      if (throwOnSend) throw new Error("send failed");
      sent.push(message);
    },
    sent,
  });
  Object.defineProperties(result, {
    ...Object.getOwnPropertyDescriptors(state),
    readyState: {
      get: () => readyState,
      set(value: number) {
        readyState = value;
      },
    },
    throwOnSend: {
      get: () => throwOnSend,
      set(value: boolean) {
        throwOnSend = value;
      },
    },
  });
  return result;
}
