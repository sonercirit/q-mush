import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

interface StagedRunnerRemoval {
  readonly interruptedSessionIds: ReadonlySet<string>;
  readonly userId: string;
}

export interface RunnerRemovalCoordinatorDependencies {
  readonly broker: Pick<
    RunnerCommandBroker,
    "cancelSessionCommands" | "runnerRemoved"
  >;
  readonly now: () => number;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runtimes: Pick<SessionRuntimes, "abort" | "settled">;
  readonly store: Pick<
    SessionStore,
    "appendInterruptedRunnerTool" | "get" | "list"
  >;
}

export class RunnerRemovalCoordinator {
  readonly #dependencies: RunnerRemovalCoordinatorDependencies;
  readonly #staged = new Map<string, StagedRunnerRemoval>();

  constructor(dependencies: RunnerRemovalCoordinatorDependencies) {
    this.#dependencies = dependencies;
  }

  removing(userId: string, runnerId: string): void {
    if (this.#staged.has(runnerId)) {
      throw new Error("The runner is already being removed");
    }
    const interrupted = this.#dependencies.broker
      .runnerRemoved(runnerId)
      .map(({ command }) => command);
    for (const session of this.#dependencies.store.list(userId)) {
      if (session.runnerId === runnerId) {
        this.#dependencies.runtimes.abort(session.id);
        interrupted.push(
          ...this.#dependencies.broker.cancelSessionCommands(session.id),
        );
      }
    }
    this.#staged.set(runnerId, {
      interruptedSessionIds: new Set(
        interrupted.map(({ sessionId }) => sessionId),
      ),
      userId,
    });
  }

  async removed(userId: string, runnerId: string): Promise<void> {
    const staged = this.#staged.get(runnerId);
    if (staged?.userId === userId) {
      this.#staged.delete(runnerId);
    }
    const affected = this.#dependencies.store
      .list(userId)
      .filter(
        (session) => session.runnerId === runnerId && session.runnerRequired,
      );
    const interruptedSessionIds = new Set(
      staged?.userId === userId ? staged.interruptedSessionIds : [],
    );
    for (const session of affected) {
      if (
        this.#dependencies.broker.cancelSessionCommands(session.id).length > 0
      ) {
        interruptedSessionIds.add(session.id);
      }
    }

    for (const session of affected) {
      this.#dependencies.runtimes.abort(session.id);
      if (
        interruptedSessionIds.has(session.id) &&
        this.#dependencies.store.get(userId, session.id)?.status === "idle"
      ) {
        this.#dependencies.store.appendInterruptedRunnerTool(
          session.id,
          this.#dependencies.now(),
        );
      }
      this.#dependencies.notify(userId, session.id);
    }
    await Promise.allSettled(
      affected.map((session) =>
        this.#dependencies.runtimes.settled(session.id),
      ),
    );
  }
}
