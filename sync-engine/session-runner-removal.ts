import type {
  RunnerCommandBroker,
  RunnerToolCommand,
} from "../shared/runner-command-broker.ts";
import type { SessionRuntimes } from "./session-runtime.ts";
import type { SessionStore } from "./session-store.ts";

export interface RunnerRemovalDependencies {
  readonly broker: Pick<RunnerCommandBroker, "runnerRemoved">;
  readonly now: () => number;
  readonly runnerId: string;
  readonly notify: (userId: string, sessionId: string) => void;
  readonly runtimes: Pick<SessionRuntimes, "abort" | "settled">;
  readonly store: Pick<
    SessionStore,
    "appendInterruptedRunnerTool" | "get" | "list"
  >;
  readonly userId: string;
}

export async function handleRemovedSessionRunner(
  options: RunnerRemovalDependencies,
): Promise<void> {
  const affected = options.store
    .list(options.userId)
    .filter(
      (session) =>
        session.runnerId === options.runnerId && session.runnerRequired,
    );
  const interruptedBySession = new Map<string, RunnerToolCommand[]>();
  for (const { command } of options.broker.runnerRemoved(options.runnerId)) {
    const commands = interruptedBySession.get(command.sessionId) ?? [];
    commands.push(command);
    interruptedBySession.set(command.sessionId, commands);
  }
  for (const session of affected) {
    options.runtimes.abort(session.id);
    const interrupted = interruptedBySession.get(session.id) ?? [];
    for (const command of interrupted) {
      if (!command.sessionId.startsWith("directory-picker:")) {
        const detail = options.store.get(options.userId, session.id);
        const call = detail?.messages
          .filter(({ role }) => role === "assistant")
          .flatMap(({ toolCalls }) => toolCalls)
          .findLast(({ name }) => name === command.tool);
        options.store.appendInterruptedRunnerTool(
          session.id,
          call?.id ?? command.id,
          command.tool,
          options.now(),
        );
      }
    }
    options.notify(options.userId, session.id);
  }
  await Promise.allSettled(
    affected.map((session) => options.runtimes.settled(session.id)),
  );
}
