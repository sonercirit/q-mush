import type { RunnerCommandBroker } from "../shared/runner-command-broker.ts";
import type { SessionLifecycleDependencies } from "./session-lifecycle-types.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store-interface.ts";

interface StagedRunnerRemoval {
  readonly interruptedSessionIds: ReadonlySet<string>;
  readonly userId: string;
}

export interface RunnerRemovalCoordinatorDependencies extends SessionLifecycleDependencies {
  readonly broker: Pick<
    RunnerCommandBroker,
    "cancelSessionCommands" | "runnerRemoved"
  >;
  readonly runtimes: Pick<SessionRuntimes, "abort" | "settled">;
  readonly store: Pick<
    SessionStore,
    "appendInterruptedRunnerTool" | "get" | "list"
  >;
}

export interface RunnerRemovalCoordinator {
  readonly removed: (userId: string, runnerId: string) => Promise<void>;
  readonly removing: (userId: string, runnerId: string) => void;
}

export function createRunnerRemovalCoordinator(
  dependencies: RunnerRemovalCoordinatorDependencies,
): RunnerRemovalCoordinator {
  const stagedRemovals = new Map<string, StagedRunnerRemoval>();

  function removing(userId: string, runnerId: string): void {
    if (stagedRemovals.has(runnerId)) {
      throw new Error("The runner is already being removed");
    }
    const interrupted = dependencies.broker
      .runnerRemoved(runnerId)
      .map(({ command }) => command);
    for (const session of dependencies.store.list(userId)) {
      if (session.runnerId === runnerId) {
        dependencies.runtimes.abort(session.id);
        interrupted.push(
          ...dependencies.broker.cancelSessionCommands(session.id),
        );
      }
    }
    stagedRemovals.set(runnerId, {
      interruptedSessionIds: new Set(
        interrupted.map(({ sessionId }) => sessionId),
      ),
      userId,
    });
  }

  async function removed(userId: string, runnerId: string): Promise<void> {
    const staged = stagedRemovals.get(runnerId);
    if (staged?.userId === userId) {
      stagedRemovals.delete(runnerId);
    }
    const affected = dependencies.store
      .list(userId)
      .filter(
        (session) => session.runnerId === runnerId && session.runnerRequired,
      );
    const interruptedSessionIds = new Set(
      staged?.userId === userId ? staged.interruptedSessionIds : [],
    );
    for (const session of affected) {
      if (dependencies.broker.cancelSessionCommands(session.id).length > 0) {
        interruptedSessionIds.add(session.id);
      }
    }

    for (const session of affected) {
      dependencies.runtimes.abort(session.id);
      if (
        interruptedSessionIds.has(session.id) &&
        dependencies.store.get(userId, session.id)?.status === "idle"
      ) {
        dependencies.store.appendInterruptedRunnerTool(
          session.id,
          dependencies.now(),
        );
      }
      dependencies.notify(userId, session.id);
    }
    await Promise.allSettled(
      affected.map((session) => dependencies.runtimes.settled(session.id)),
    );
  }

  return { removed, removing };
}
