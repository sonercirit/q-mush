import {
  RUNNER_EXECUTION_CLEANUP_COMMAND,
  type RunnerCommandBroker,
} from "../shared/runner-command-broker.ts";
import type { AgentSessionDetail } from "../shared/session-model.ts";

export class SessionExecutionCleanup {
  readonly #broker: RunnerCommandBroker;
  readonly #offline = new Set<string>();
  readonly #pending = new Map<string, Promise<void>>();

  constructor(broker: RunnerCommandBroker) {
    this.#broker = broker;
  }

  get pending(): Iterable<Promise<void>> {
    return this.#pending.values();
  }

  clearOffline(sessionId: string): void {
    this.#offline.delete(sessionId);
  }

  markOffline(sessionId: string): void {
    this.#offline.add(sessionId);
  }

  cleanup(detail: AgentSessionDetail): Promise<void> {
    if (
      detail.executionEnvironment !== "container" ||
      this.#offline.delete(detail.id)
    ) {
      return Promise.resolve();
    }
    const existing = this.#pending.get(detail.id);
    if (existing !== undefined) {
      return existing;
    }
    const cleanup = this.#broker
      .dispatch({
        arguments: {},
        executionEnvironment: detail.executionEnvironment,
        runnerId: detail.runnerId,
        sessionId: detail.id,
        tool: RUNNER_EXECUTION_CLEANUP_COMMAND,
        workingDirectory: detail.workingDirectory,
      })
      .then(() => undefined)
      .catch(() => undefined);
    this.#pending.set(detail.id, cleanup);
    void cleanup.then(() => {
      if (this.#pending.get(detail.id) === cleanup) {
        this.#pending.delete(detail.id);
      }
    });
    return cleanup;
  }

  waitFor(sessionId: string): Promise<void> | undefined {
    return this.#pending.get(sessionId);
  }
}
