import type { RestartDeadline } from "../shared/restart-deadline.ts";
import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerCommandBroker,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export class SessionExecutionCleanup {
  readonly #broker: RunnerCommandBroker;
  #draining = false;
  readonly #offline = new Set<string>();
  readonly #pending = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly promise: Promise<void>;
      readonly terminal: boolean;
    }
  >();

  constructor(broker: RunnerCommandBroker) {
    this.#broker = broker;
  }

  get pending(): Iterable<Promise<void>> {
    return [...this.#pending.values()].map(({ promise }) => promise);
  }

  cancelPending(): void {
    for (const [sessionId, pending] of this.#pending) {
      pending.controller.abort(
        new DOMException("The server is restarting", "RestartHandoff"),
      );
      this.#broker.cancelSessionCommands(sessionId);
    }
  }

  async drainPending(deadline: RestartDeadline): Promise<void> {
    // Development restart always exits this process after draining begins.
    this.#draining = true;
    const pending = [...this.pending];
    if (pending.length === 0) return;
    if (deadline.expired()) {
      this.cancelPending();
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
        Promise.allSettled(pending).then(() => true),
        expired,
      ]);
      if (!completed) {
        this.cancelPending();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  clearOffline(sessionId: string): void {
    this.#offline.delete(sessionId);
  }

  markOffline(sessionId: string): void {
    this.#offline.add(sessionId);
  }

  cleanup(detail: AgentSessionDetail): Promise<void> {
    if (detail.executionEnvironment !== "container") {
      return Promise.resolve();
    }
    return this.#dispatch(detail, false);
  }

  cleanupTerminal(detail: AgentSessionDetail): Promise<void> {
    return this.#dispatch(detail, true);
  }

  #dispatch(detail: AgentSessionDetail, terminal: boolean): Promise<void> {
    if (this.#offline.delete(detail.id) || this.#draining) {
      return Promise.resolve();
    }
    const existing = this.#pending.get(detail.id);
    if (existing !== undefined && (!terminal || existing.terminal)) {
      return existing.promise;
    }
    const dispatch = (signal: AbortSignal) =>
      this.#draining
        ? Promise.resolve()
        : this.#broker
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
    const cleanup =
      existing === undefined
        ? dispatch(controller.signal)
        : existing.promise.then(() => dispatch(controller.signal));
    const pending = { controller, promise: cleanup, terminal };
    this.#pending.set(detail.id, pending);
    void cleanup.then(() => {
      if (this.#pending.get(detail.id) === pending) {
        this.#pending.delete(detail.id);
      }
    });
    return cleanup;
  }

  waitFor(sessionId: string): Promise<void> | undefined {
    return this.#pending.get(sessionId)?.promise;
  }
}
