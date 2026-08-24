import type { RestartDeadline } from "../shared/restart-deadline.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerCommandBroker,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export interface SessionExecutionCleanup {
  readonly pending: Iterable<Promise<void>>;
  readonly cancelPending: () => void;
  readonly cleanup: (detail: AgentSessionDetail) => Promise<void>;
  readonly cleanupTerminal: (detail: AgentSessionDetail) => Promise<void>;
  readonly clearOffline: (sessionId: string) => void;
  readonly drainPending: (deadline: RestartDeadline) => Promise<void>;
  readonly markOffline: (sessionId: string) => void;
  readonly waitFor: (sessionId: string) => Promise<void> | undefined;
}

export function createSessionExecutionCleanup(
  broker: RunnerCommandBroker,
): SessionExecutionCleanup {
  let activeDrains = 0;
  let drainGeneration = 0;
  const offline = new Set<string>();
  const pending = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly promise: Promise<void>;
      readonly terminal: boolean;
    }
  >();

  const cancelPending = (): void => {
    for (const [sessionId, operation] of pending) {
      operation.controller.abort(
        new DOMException("The server is restarting", "RestartHandoff"),
      );
      broker.cancelSessionCommands(sessionId);
    }
  };

  const drainPending = async (deadline: RestartDeadline): Promise<void> => {
    activeDrains += 1;
    drainGeneration += 1;
    const operations = [...pending.values()].map(({ promise }) => promise);
    try {
      if (operations.length === 0) return;
      if (deadline.expired()) {
        cancelPending();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, deadline.remaining());
      });
      try {
        const completed = await Promise.race([
          Promise.allSettled(operations).then(() => true),
          expired,
        ]);
        if (!completed) cancelPending();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      activeDrains -= 1;
    }
  };

  const dispatch = (
    detail: AgentSessionDetail,
    terminal: boolean,
  ): Promise<void> => {
    if (offline.delete(detail.id) || activeDrains > 0) return Promise.resolve();
    const existing = pending.get(detail.id);
    if (existing !== undefined && (!terminal || existing.terminal)) {
      return existing.promise;
    }
    const dispatchGeneration = drainGeneration;
    const run = (signal: AbortSignal) =>
      activeDrains > 0 || dispatchGeneration !== drainGeneration
        ? Promise.resolve()
        : broker
            .dispatch(
              {
                arguments: terminal
                  ? { [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true }
                  : {},
                executionEnvironment: detail.executionEnvironment,
                runnerId: detail.runnerId,
                sessionId: detail.id,
                tool: RUNNER_EXECUTION_CLEANUP_COMMAND,
                workingDirectory: detail.workingDirectory,
              },
              signal,
            )
            .then(() => undefined)
            .catch(() => undefined);
    const controller = new AbortController();
    const promise =
      existing === undefined
        ? run(controller.signal)
        : existing.promise.then(() => run(controller.signal));
    const operation = { controller, promise, terminal };
    pending.set(detail.id, operation);
    void promise.then(() => {
      if (pending.get(detail.id) === operation) pending.delete(detail.id);
    });
    return promise;
  };

  return {
    get pending() {
      return [...pending.values()].map(({ promise }) => promise);
    },
    cancelPending,
    cleanup: (detail) =>
      detail.executionEnvironment === "container"
        ? dispatch(detail, false)
        : Promise.resolve(),
    cleanupTerminal: (detail) => dispatch(detail, true),
    clearOffline: (sessionId) => offline.delete(sessionId) && undefined,
    drainPending,
    markOffline: (sessionId) => {
      offline.add(sessionId);
    },
    waitFor: (sessionId) => pending.get(sessionId)?.promise,
  };
}
