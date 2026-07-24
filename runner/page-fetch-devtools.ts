import { isRecord } from "../shared/auth-model.ts";

interface DevtoolsMessage {
  readonly error?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

interface DevtoolsEvent {
  readonly method: string;
  readonly params: unknown;
}

export interface DevtoolsSubscription {
  close(): void;
  next(): Promise<DevtoolsEvent | undefined>;
}

function readMessage(event: MessageEvent): DevtoolsMessage | undefined {
  if (typeof event.data !== "string") {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(event.data);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function errorMessage(value: unknown): string {
  if (isRecord(value) && typeof value["message"] === "string") {
    return value["message"];
  }
  return String(value);
}

function closedError(): Error {
  return new Error("Chromium closed before the page was ready");
}

export class DevtoolsConnection {
  readonly #events = new Map<string, Set<(params: unknown) => void>>();
  readonly #pending = new Map<
    number,
    {
      readonly reject: (error: Error) => void;
      readonly resolve: (result: unknown) => void;
    }
  >();
  #nextId = 0;
  readonly #socket: WebSocket;

  constructor(url: string) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", (event) => {
      const message = readMessage(event);
      if (message === undefined) {
        return;
      }
      if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (pending !== undefined) {
          this.#pending.delete(message.id);
          if (message.error === undefined) {
            pending.resolve(message.result);
          } else {
            pending.reject(
              new Error(
                `Chromium command failed: ${errorMessage(message.error)}`,
              ),
            );
          }
        }
      } else if (typeof message.method === "string") {
        for (const listener of this.#events.get(message.method) ?? []) {
          listener(message.params);
        }
      }
    });
    const rejectPending = (): void => {
      for (const pending of this.#pending.values()) {
        pending.reject(closedError());
      }
      this.#pending.clear();
      for (const listeners of this.#events.values()) {
        for (const listener of listeners) {
          listener(undefined);
        }
      }
      this.#events.clear();
    };
    this.#socket.addEventListener("close", rejectPending, { once: true });
    this.#socket.addEventListener("error", rejectPending, { once: true });
  }

  open(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#socket.addEventListener(
        "open",
        () => {
          resolve();
        },
        { once: true },
      );
      this.#socket.addEventListener(
        "error",
        () => {
          reject(new Error("Could not connect to Chromium DevTools"));
        },
        { once: true },
      );
    });
  }

  close(): void {
    this.#socket.close();
  }

  command(method: string, params: Readonly<Record<string, unknown>> = {}) {
    const id = (this.#nextId += 1);
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  subscribe(methods: readonly string[]): DevtoolsSubscription {
    const values: DevtoolsEvent[] = [];
    const waiters: ((value: DevtoolsEvent | undefined) => void)[] = [];
    const registered: {
      readonly listener: (params: unknown) => void;
      readonly method: string;
    }[] = [];
    let closed = false;
    const endWaiters = (): void => {
      for (const waiter of waiters.splice(0)) {
        waiter(undefined);
      }
    };
    const emit = (value: DevtoolsEvent | undefined): void => {
      if (closed) {
        return;
      }
      if (value === undefined) {
        closed = true;
        values.splice(0);
        endWaiters();
        return;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) {
        values.push(value);
      } else {
        waiter(value);
      }
    };
    for (const method of methods) {
      const listeners = this.#events.get(method) ?? new Set();
      const listener = (params: unknown): void => {
        emit(params === undefined ? undefined : { method, params });
      };
      listeners.add(listener);
      this.#events.set(method, listeners);
      registered.push({ listener, method });
    }
    return {
      close: () => {
        if (!closed) {
          closed = true;
          endWaiters();
        }
        for (const { listener, method } of registered) {
          const listeners = this.#events.get(method);
          listeners?.delete(listener);
          if (listeners?.size === 0) {
            this.#events.delete(method);
          }
        }
      },
      next: () => {
        const value = values.shift();
        if (value !== undefined) {
          return Promise.resolve(value);
        }
        if (closed) {
          return Promise.resolve(undefined);
        }
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      },
    };
  }
}

function pageDevtoolsUrl(browserUrl: string, targetId: string): string {
  const url = new URL(browserUrl);
  return `${url.protocol}//${url.host}/devtools/page/${targetId}`;
}

function pageTargetId(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value["targetInfos"])) {
    throw new Error("Chromium did not report its page target");
  }
  for (const target of value["targetInfos"]) {
    if (
      isRecord(target) &&
      target["type"] === "page" &&
      typeof target["targetId"] === "string"
    ) {
      return target["targetId"];
    }
  }
  throw new Error("Chromium did not report its page target");
}

export async function connectToPage(
  browserUrl: string,
): Promise<DevtoolsConnection> {
  const browser = new DevtoolsConnection(browserUrl);
  try {
    await browser.open();
    const targetId = pageTargetId(await browser.command("Target.getTargets"));
    return new DevtoolsConnection(pageDevtoolsUrl(browserUrl, targetId));
  } finally {
    browser.close();
  }
}
