import { Database } from "bun:sqlite";
import type { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type { CausalFrontier } from "../shared/operation-core.ts";
import { testOperation } from "./operation-core-test-support.ts";

export type RunnerOperationTestStore = ReturnType<
  typeof createRunnerOperationStore
>;
export const runnerOwnerId = "owner-1";

export const ownedRunnerOperation = (
  operation: ReturnType<typeof testOperation>,
) => ({
  ...operation,
  entity: { ...operation.entity, accountId: runnerOwnerId },
});
export const runnerEnvelope = (
  sequence: bigint,
  value = `value-${String(sequence)}`,
) =>
  encodeOperationEnvelope(
    ownedRunnerOperation(
      testOperation(runnerOwnerId, sequence, {}, value, Number(sequence)),
    ),
  );
export const applyRunnerEnvelope = (
  store: RunnerOperationTestStore,
  encoded = runnerEnvelope(1n),
): string => {
  store.apply(runnerOwnerId, "non-session", [encoded], "remote");
  return encoded;
};

export const withRunnerOperationStore = (
  create: (database: Database) => RunnerOperationTestStore,
  run: (store: RunnerOperationTestStore, database: Database) => void,
) => {
  const database = new Database(":memory:");
  try {
    run(create(database), database);
  } finally {
    database.close();
  }
};
export const expectRunnerOperationState = (
  store: RunnerOperationTestStore,
  expected: {
    readonly replayCount?: number;
    readonly stalled?: boolean;
  },
) => {
  const state = store.state(runnerOwnerId, "non-session");
  if (
    expected.replayCount !== undefined &&
    state.replayCount !== expected.replayCount
  )
    throw new Error(`Expected replay count ${String(expected.replayCount)}`);
  if (expected.stalled !== undefined && state.stalled !== expected.stalled)
    throw new Error(`Expected stalled ${String(expected.stalled)}`);
};

export const compactRunnerOperationStore = (
  store: RunnerOperationTestStore,
  stableSequence: bigint,
) => {
  const stableFrontier: CausalFrontier = { [runnerOwnerId]: stableSequence };
  store.compact({
    ownerId: runnerOwnerId,
    partition: "non-session",
    stableClock: {
      physicalMs: Number(stableSequence),
      logical: 0,
      writerId: runnerOwnerId,
    },
    stableFrontier,
  });
};
