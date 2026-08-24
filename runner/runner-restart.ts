interface RunnerRestartSocket {
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

export interface RunnerRestartCoordinator {
  readonly pending: boolean;
  readonly pendingRestartId: string | undefined;
  restore(restartId: string): void;
  readonly connectionContext: <Context extends { readonly restartId?: string }>(
    current: Context,
  ) => Context;
  operational(restartId: string | undefined): boolean;
  request(socket: RunnerRestartSocket): Promise<string>;
}
export function createRunnerRestartCoordinator(
  options: RunnerRestartCoordinatorOptions,
): RunnerRestartCoordinator {
  const restartIdFactory = options.restartId;
  let pendingState: PendingRestart | undefined;
  const coordinator: RunnerRestartCoordinator & {
    bind(p: PendingRestart, a: RestartAttempt): void;
    complete(p: PendingRestart): void;
    fail(p: PendingRestart, a: RestartAttempt, e: Error): void;
  } = {
    restore(restartId: string): void {
      if (restartId.length === 0 || restartId.length > 200) {
        throw new Error("The runner restart ID is invalid");
      }
      if (pendingState !== undefined && pendingState.restartId !== restartId) {
        throw new Error("A different runner restart is already pending");
      }
      pendingState ??= {
        attempt: undefined,
        operational: false,
        ready: true,
        restartId,
        sent: true,
      };
    },

    get pending(): boolean {
      return pendingState !== undefined;
    },

    get pendingRestartId(): string | undefined {
      return pendingState?.restartId;
    },

    connectionContext<Context extends { readonly restartId?: string }>(
      current: Context,
    ): Context {
      return pendingState?.sent === true
        ? { ...current, restartId: pendingState.restartId }
        : current;
    },

    operational(restartId: string | undefined): boolean {
      const pending = pendingState;
      if (restartId === undefined) return pending === undefined;
      if (pending?.restartId !== restartId) return false;
      pending.operational = true;
      coordinator.complete(pending);
      return true;
    },

    request(socket: RunnerRestartSocket): Promise<string> {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(
          new Error("The runner disconnected before restart was safe"),
        );
      }
      let pending = pendingState;
      if (pending === undefined) {
        const restartId = restartIdFactory();
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
        pendingState = pending;
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
          coordinator.fail(
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
      coordinator.bind(pending, attempt);
      return attempt.promise;
    },

    bind(pending: PendingRestart, attempt: RestartAttempt): void {
      const { socket } = attempt;
      socket.addEventListener("message", (rawEvent) => {
        if (
          rawEvent instanceof MessageEvent &&
          typeof rawEvent.data === "string" &&
          pendingState === pending &&
          pending.attempt === attempt &&
          restartAcknowledgement(rawEvent.data, pending.restartId)
        ) {
          pending.attempt = undefined;
          pending.ready = true;
          attempt.resolve(pending.restartId);
          coordinator.complete(pending);
        }
      });
      const failOnSocketEvent = (
        type: "close" | "error",
        message: string,
      ): void => {
        socket.addEventListener(
          type,
          () => {
            coordinator.fail(pending, attempt, new Error(message));
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
        coordinator.fail(
          pending,
          attempt,
          error instanceof Error
            ? error
            : new Error("The runner restart request could not be sent"),
        );
      }
    },

    complete(pending: PendingRestart): void {
      if (
        pendingState === pending &&
        pending.operational &&
        pending.ready &&
        pending.attempt === undefined
      ) {
        pendingState = undefined;
      }
    },

    fail(pending: PendingRestart, attempt: RestartAttempt, error: Error): void {
      if (pendingState === pending && pending.attempt === attempt) {
        pending.attempt = undefined;
        attempt.reject(error);
      }
    },
  };
  return coordinator;
}
