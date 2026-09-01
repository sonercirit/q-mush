import { expect, test } from "vitest";

import { synchronizeRunnerOperations } from "../runner/runner-operation-sync";
import { MAX_OPERATION_SYNC_BATCH_BYTES } from "../shared/operation-core";

const largeEnvelope = "x".repeat(240_000);

test("runner push splits the outbox into byte-capped batches", async () => {
  const writes: number[] = [];
  const pending = Array.from({ length: 20 }, () => largeEnvelope);
  const acknowledge = (
    _owner: string,
    _partition: string,
    envelopes: readonly string[],
  ): void => {
    pending.splice(0, envelopes.length);
  };
  const store = {
    acknowledge,
    pending: () => pending,
    apply: () => undefined,
    state: () => ({ frontier: {} }),
    stallOutbox: () => undefined,
  };
  await synchronizeRunnerOperations(
    store,
    {
      readPage: () => Promise.resolve({ envelopes: [], hasMore: false }),
      writeBatch: (_partition, envelopes) => {
        writes.push(envelopes.join("").length);
        return Promise.resolve();
      },
    },
    new AbortController().signal,
  );
  expect(writes.length).toBeGreaterThan(1);
  expect(writes.every((bytes) => bytes <= MAX_OPERATION_SYNC_BATCH_BYTES)).toBe(
    true,
  );
  expect(pending).toEqual([]);
});
