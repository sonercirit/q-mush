import type { RealtimeSocket } from "./realtime-hub.ts";
import type { PendingRunnerRegistration } from "./realtime-runner-runtime.ts";
import type { RealtimeRegistrationDependencies } from "./realtime-runner-types.ts";
import type { RunnerConnection } from "./runner-store.ts";

export type CurrentPendingRunnerParameters = readonly [
  options: RealtimeRegistrationDependencies,
  pending: PendingRunnerRegistration,
  socket: RealtimeSocket,
];

export function currentPendingRunner(
  ...[options, pending, socket]: CurrentPendingRunnerParameters
): RunnerConnection | undefined {
  const runner = pending.committed;
  return runner !== undefined && options.hub.runnerIsCurrent(runner.id, socket)
    ? runner
    : undefined;
}
