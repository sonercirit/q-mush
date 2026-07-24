export interface RunnerRestartSocket {
  readonly readyState: number;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  send(message: string): void;
}

interface RunnerRestartCoordinatorOptions {
  readonly restartId: () => string;
}

export class RunnerRestartCoordinator {
  readonly #restartId: () => string;
  #pending:
    | {
        readonly promise: Promise<void>;
        readonly reject: (error: Error) => void;
        readonly resolve: () => void;
        readonly restartId: string;
        readonly socket: RunnerRestartSocket;
      }
    | undefined;

  constructor(options: RunnerRestartCoordinatorOptions) {
    this.#restartId = options.restartId;
  }

  request(socket: RunnerRestartSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("The runner disconnected before restart was safe"),
      );
    }
    if (this.#pending !== undefined) {
      return this.#pending.socket === socket
        ? this.#pending.promise
        : Promise.reject(
            new Error("The runner restart connection was replaced"),
          );
    }
    const restartId = this.#restartId();
    if (restartId.length === 0 || restartId.length > 200) {
      return Promise.reject(new Error("The runner restart ID is invalid"));
    }
    let resolvePromise: (() => void) | undefined;
    let rejectPromise: ((error: Error) => void) | undefined;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    if (resolvePromise === undefined || rejectPromise === undefined) {
      throw new Error("The runner restart promise could not be initialized");
    }
    const pending = {
      promise,
      reject: rejectPromise,
      resolve: resolvePromise,
      restartId,
      socket,
    };
    this.#pending = pending;
    socket.addEventListener("message", (rawEvent) => {
      if (!(rawEvent instanceof MessageEvent)) {
        return;
      }
      const event = rawEvent;
      if (typeof event.data !== "string" || this.#pending !== pending) {
        return;
      }
      try {
        const value: unknown = JSON.parse(event.data);
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "restart_ready" &&
          "restartId" in value &&
          value.restartId === restartId
        ) {
          this.#pending = undefined;
          pending.resolve();
        }
      } catch {
        // The connection's normal protocol validation handles malformed data.
      }
    });
    const rejectPending = (message: string): void => {
      if (this.#pending === pending) {
        this.#pending = undefined;
        pending.reject(new Error(message));
      }
    };
    const rejectOn = (type: "close" | "error", message: string): void => {
      socket.addEventListener(
        type,
        () => {
          rejectPending(message);
        },
        { once: true },
      );
    };
    rejectOn("error", "The runner connection failed before restart was safe");
    rejectOn("close", "The runner disconnected before restart was safe");
    try {
      socket.send(JSON.stringify({ restartId, type: "restart" }));
    } catch (error) {
      if (this.#pending === pending) {
        this.#pending = undefined;
      }
      pending.reject(
        error instanceof Error
          ? error
          : new Error("The runner restart request could not be sent"),
      );
    }
    return promise;
  }
}
