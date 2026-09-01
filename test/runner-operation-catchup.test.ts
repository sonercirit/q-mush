import { expect, test } from "vitest";

import { createRunnerOperationStore } from "../runner/runner-operation-store.ts";
import { encodeOperationEnvelope } from "../shared/operation-checkpoint.ts";
import type { OperationStabilityBoundary } from "../shared/operation-stability.ts";
import { testOperation } from "./operation-core-test-support.ts";
import {
  ownedRunnerOperation,
  runnerOwnerId,
  withRunnerOperationStore,
  type RunnerOperationTestStore,
} from "./runner-operation-store-test-support.ts";

const writerEnvelope = (
  writerId: string,
  sequence: bigint,
  physicalMs: number,
  value: string,
) =>
  encodeOperationEnvelope(
    ownedRunnerOperation(
      testOperation(writerId, sequence, {}, value, physicalMs),
    ),
  );

const stability: OperationStabilityBoundary = {
  stableClock: { physicalMs: 30, logical: 0, writerId: "writer-a" },
  stableFrontier: { "writer-a": 2n, "writer-b": 2n },
};

const applyRemote = (
  store: RunnerOperationTestStore,
  envelopes: readonly string[],
) => {
  store.apply(runnerOwnerId, "non-session", envelopes, "remote", stability);
};

const projectionAndFrontier = (store: RunnerOperationTestStore) => {
  const state = store.state(runnerOwnerId, "non-session");
  return { projection: state.projection, frontier: state.frontier };
};

test("runner catch-up waits for every stable writer before folding reordered pages", () => {
  const writerA = [
    writerEnvelope("writer-a", 1n, 20, "a-20"),
    writerEnvelope("writer-a", 2n, 30, "a-30"),
  ];
  const writerB = [
    writerEnvelope("writer-b", 1n, 5, "b-5"),
    writerEnvelope("writer-b", 2n, 10, "b-10"),
  ];

  withRunnerOperationStore(createRunnerOperationStore, (pagedStore) => {
    applyRemote(pagedStore, writerA);
    const afterWriterA = pagedStore.state(runnerOwnerId, "non-session");
    expect(
      afterWriterA.stableClock,
      "page one must not fold early",
    ).toBeUndefined();
    expect(
      afterWriterA.replayCount,
      "page one must retain writer A replay",
    ).toBe(2);

    applyRemote(pagedStore, writerB);
    const afterWriterB = pagedStore.state(runnerOwnerId, "non-session");
    expect(afterWriterB.stalled, "older writer B page must be admitted").toBe(
      false,
    );
    expect(
      pagedStore.inspect(runnerOwnerId, "non-session"),
      "all writer B operations must be accepted",
    ).toHaveLength(4);
    expect(afterWriterB.stableClock, "covered frontier must fold").toEqual(
      stability.stableClock,
    );
    expect(afterWriterB.replayCount, "covered replay must drain").toBe(0);

    withRunnerOperationStore(createRunnerOperationStore, (canonicalStore) => {
      applyRemote(canonicalStore, [...writerB, ...writerA]);
      expect(projectionAndFrontier(pagedStore)).toEqual(
        projectionAndFrontier(canonicalStore),
      );
    });
  });
});
