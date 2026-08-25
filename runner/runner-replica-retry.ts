import type { AccountExportRetryProgress } from "./runner-account-export-client.ts";

export function recordReplicaRetry(
  replica: {
    readonly recordRetry: (retry: AccountExportRetryProgress) => void;
  },
  retry: AccountExportRetryProgress,
  log: (message: string) => void = console.warn,
): void {
  replica.recordRetry(retry);
  const { elapsedMilliseconds, previousRevision, restartCount, revision } =
    retry;
  log(
    `Replica catch-up joining: revision changed ${previousRevision} -> ${revision}; restart ${String(restartCount)}, elapsed ${String(elapsedMilliseconds)}ms`,
  );
}
