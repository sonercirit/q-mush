import type { PendingRunnerRegistration } from "./realtime-runner-runtime.ts";
import type { RunnerConnection } from "./runner-store.ts";

export function pendingRunnerConnection(
  pending: PendingRunnerRegistration,
): Readonly<{ connection: RunnerConnection; userId: string }> | undefined {
  const connection = pending.committed;
  return connection === undefined
    ? undefined
    : { connection, userId: connection.userId };
}
