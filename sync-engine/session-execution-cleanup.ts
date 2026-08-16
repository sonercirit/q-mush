import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  RUNNER_TERMINAL_CLEANUP_ARGUMENT,
  type RunnerCommandBroker,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export class SessionExecutionCleanup {
  readonly #broker: RunnerCommandBroker;
  readonly #offline = new Set<string>();
  readonly #pending = new Map<
    string,
    { readonly promise: Promise<void>; readonly terminal: boolean }
  >();

  constructor(broker: RunnerCommandBroker) {
    this.#broker = broker;
  }

  get pending(): Iterable<Promise<void>> {
    return [...this.#pending.values()].map(({ promise }) => promise);
  }

  cancelPending(): void {
    for (const sessionId of this.#pending.keys()) {
      this.#broker.cancelSessionCommands(sessionId);
    }
  }

  async drainPending(milliseconds: number): Promise<void> {
    const pending = [...this.pending];
    if (pending.length === 0) return;
    const timedOut = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => {
      this.cancelPending();
      timedOut.resolve(true);
    }, milliseconds);
    const completed = Promise.allSettled(pending).then(() => false);
    try {
      if (await Promise.race([completed, timedOut.promise])) {
        await completed;
      }
    } finally {
      clearTimeout(timer);
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
    if (this.#offline.delete(detail.id)) {
      return Promise.resolve();
    }
    const existing = this.#pending.get(detail.id);
    if (existing !== undefined && (!terminal || existing.terminal)) {
      return existing.promise;
    }
    const dispatch = () =>
      this.#broker
        .dispatch({
          arguments: terminal
            ? { [RUNNER_TERMINAL_CLEANUP_ARGUMENT]: true }
            : {},
          executionEnvironment: detail.executionEnvironment,
          runnerId: detail.runnerId,
          sessionId: detail.id,
          tool: RUNNER_EXECUTION_CLEANUP_COMMAND,
          workingDirectory: detail.workingDirectory,
        })
        .then(() => undefined)
        .catch(() => undefined);
    const cleanup =
      existing === undefined ? dispatch() : existing.promise.then(dispatch);
    const pending = { promise: cleanup, terminal };
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
