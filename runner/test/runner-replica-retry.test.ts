import { expect, test, vi } from "vitest";
import type { AccountExportRetryProgress } from "../runner-account-export-client.ts";
import { recordReplicaRetry } from "../runner-replica-retry.ts";

test("runner catch-up persists and logs retry progress", () => {
  const recordRetry = vi.fn<(retry: AccountExportRetryProgress) => void>();
  const log = vi.fn<(message: string) => void>();
  const progress: AccountExportRetryProgress = {
    elapsedMilliseconds: 879,
    previousRevision: "revision-before",
    restartCount: 3,
    revision: "revision-after",
  };
  recordReplicaRetry({ recordRetry }, progress, log);
  expect(recordRetry).toHaveBeenCalledWith(progress);
  expect(log).toHaveBeenCalledWith(
    "Replica catch-up joining: revision changed revision-before -> revision-after; restart 3, elapsed 879ms",
  );
});
