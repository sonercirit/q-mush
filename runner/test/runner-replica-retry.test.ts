import { expect, test, vi } from "vitest";
import type { AccountExportRetryProgress } from "../runner-account-export-client.ts";
import { recordReplicaRetry } from "../runner-replica-retry.ts";

test("runner catch-up persists and logs retry progress", () => {
  const recordRetry = vi.fn<(retry: AccountExportRetryProgress) => void>();
  const log = vi.fn<(message: string) => void>();
  const retry = {
    elapsedMilliseconds: 123,
    previousRevision: "old",
    restartCount: 2,
    revision: "new",
  };
  recordReplicaRetry({ recordRetry }, retry, log);
  expect(recordRetry).toHaveBeenCalledWith(retry);
  expect(log).toHaveBeenCalledWith(
    "Replica catch-up joining: revision changed old -> new; restart 2, elapsed 123ms",
  );
});
