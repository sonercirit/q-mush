export class RealtimeTestSocket extends EventTarget {
  #closed = false;
  #opened = false;
  readonly sent: string[] = [];
  readonly url: string | undefined;

  constructor(url?: string) {
    super();
    this.url = url;
  }

  get readyState(): number {
    if (this.#closed) {
      return WebSocket.CLOSED;
    }
    return this.#opened ? WebSocket.OPEN : WebSocket.CONNECTING;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.dispatchEvent(new Event("close"));
  }

  open(instanceId?: string): void {
    this.#opened = true;
    this.dispatchEvent(new Event("open"));
    if (instanceId !== undefined) {
      this.receive({ instanceId, type: "ready" });
    }
  }

  receive(value: unknown): void {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(message: string): void {
    this.sent.push(message);
  }
}
