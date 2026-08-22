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

interface RestartAttempt {
  readonly promise: Promise<string>;
  readonly reject: (error: Error) => void;
  readonly resolve: (restartId: string) => void;
  readonly socket: RunnerRestartSocket;
}

interface PendingRestart {
  attempt: RestartAttempt | undefined;
  operational: boolean;
  ready: boolean;
  readonly restartId: string;
  sent: boolean;
}

function restartAcknowledgement(message: string, restartId: string): boolean {
  try {
    const value: unknown = JSON.parse(message);
    return (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === "restart_ready" &&
      "restartId" in value &&
      value.restartId === restartId
    );
  } catch {
    return false;
  }
}

export class RunnerRestartCoordinator {
  readonly #restartId: () => string;
  #pending: PendingRestart | undefined;

  constructor(options: RunnerRestartCoordinatorOptions) {
    this.#restartId = options.restartId;
  }

  restore(restartId: string): void {
    if (restartId.length === 0 || restartId.length > 200) {
      throw new Error("The runner restart ID is invalid");
    }
    if (this.#pending !== undefined && this.#pending.restartId !== restartId) {
      throw new Error("A different runner restart is already pending");
    }
    this.#pending ??= {
      attempt: undefined,
      operational: false,
      ready: true,
      restartId,
      sent: true,
    };
  }

  get pending(): boolean {
    return this.#pending !== undefined;
  }

  get pendingRestartId(): string | undefined {
    return this.#pending?.restartId;
  }

  connectionContext<Context extends { readonly restartId?: string }>(
    current: Context,
  ): Context {
    return this.#pending?.sent === true
      ? { ...current, restartId: this.#pending.restartId }
      : current;
  }

  operational(restartId: string | undefined): boolean {
    const pending = this.#pending;
    if (restartId === undefined) return pending === undefined;
    if (pending?.restartId !== restartId) return false;
    pending.operational = true;
    this.#complete(pending);
    return true;
  }

  request(socket: RunnerRestartSocket): Promise<string> {
    if (socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error("The runner disconnected before restart was safe"),
      );
    }
    let pending = this.#pending;
    if (pending === undefined) {
      const restartId = this.#restartId();
      if (restartId.length === 0 || restartId.length > 200) {
        return Promise.reject(new Error("The runner restart ID is invalid"));
      }
      pending = {
        attempt: undefined,
        operational: false,
        ready: false,
        restartId,
        sent: false,
      };
      this.#pending = pending;
    }
    if (pending.attempt?.socket === socket) {
      try {
        socket.send(
          JSON.stringify({
            restartId: pending.restartId,
            type: "restart_escalate",
          }),
        );
      } catch (error) {
        this.#fail(
          pending,
          pending.attempt,
          error instanceof Error
            ? error
            : new Error("The runner restart request could not be sent"),
        );
      }
      return pending.attempt.promise;
    }
    pending.attempt?.reject(
      new Error("The runner restart connection was replaced"),
    );
    let resolveAttempt: (restartId: string) => void = () => undefined;
    let rejectAttempt = (error: Error): void => {
      void error;
    };
    const promise = new Promise<string>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: RestartAttempt = {
      promise,
      reject: rejectAttempt,
      resolve: resolveAttempt,
      socket,
    };
    pending.attempt = attempt;
    this.#bind(pending, attempt);
    return attempt.promise;
  }

  #bind(pending: PendingRestart, attempt: RestartAttempt): void {
    const { socket } = attempt;
    socket.addEventListener("message", (rawEvent) => {
      if (
        rawEvent instanceof MessageEvent &&
        typeof rawEvent.data === "string" &&
        this.#pending === pending &&
        pending.attempt === attempt &&
        restartAcknowledgement(rawEvent.data, pending.restartId)
      ) {
        pending.attempt = undefined;
        pending.ready = true;
        attempt.resolve(pending.restartId);
        this.#complete(pending);
      }
    });
    const failOnSocketEvent = (
      type: "close" | "error",
      message: string,
    ): void => {
      socket.addEventListener(
        type,
        () => {
          this.#fail(pending, attempt, new Error(message));
        },
        { once: true },
      );
    };
    failOnSocketEvent(
      "error",
      "The runner connection failed before restart was safe",
    );
    failOnSocketEvent(
      "close",
      "The runner disconnected before restart was safe",
    );
    try {
      const type = pending.sent ? "restart_escalate" : "restart";
      socket.send(
        JSON.stringify({
          restartId: pending.restartId,
          type,
        }),
      );
      pending.sent = true;
    } catch (error) {
      this.#fail(
        pending,
        attempt,
        error instanceof Error
          ? error
          : new Error("The runner restart request could not be sent"),
      );
    }
  }

  #complete(pending: PendingRestart): void {
    if (
      this.#pending === pending &&
      pending.operational &&
      pending.ready &&
      pending.attempt === undefined
    ) {
      this.#pending = undefined;
    }
  }

  #fail(pending: PendingRestart, attempt: RestartAttempt, error: Error): void {
    if (this.#pending === pending && pending.attempt === attempt) {
      pending.attempt = undefined;
      attempt.reject(error);
    }
  }
}
