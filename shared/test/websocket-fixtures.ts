export interface RecordingTestSocketOptions {
  readonly closeEvent?: () => Event;
  readonly readyState?: number;
}

export class RecordingTestSocket extends EventTarget {
  readonly #closeEvent: () => Event;
  readyState: number;
  readonly sent: string[] = [];
  throwOnSend = false;

  constructor(options: RecordingTestSocketOptions = {}) {
    super();
    this.#closeEvent = options.closeEvent ?? (() => new Event("close"));
    this.readyState = options.readyState ?? WebSocket.OPEN;
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(this.#closeEvent());
  }

  receive(message: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(message) }),
    );
  }

  send(message: string): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.sent.push(message);
  }
}
