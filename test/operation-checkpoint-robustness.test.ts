import { expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import {
  operationFingerprint,
  restoreAppliedIdentityIndex,
  type OperationApplyState,
} from "../shared/operation-core";
import {
  appendOperationId,
  applyOperationList,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";

const operation = testOperation("a", 1n, {}, "x", 1);
const state = () =>
  applyOperationList(
    [operation],
    testApplyState<readonly string[]>([]),
    appendOperationId,
  );
const reject = (
  checkpoint: OperationApplyState<readonly string[]>,
  pattern: RegExp,
) => {
  expect(() =>
    decodeOperationCheckpoint(encodeOperationCheckpoint(checkpoint)),
  ).toThrow(pattern);
};

test("rejects a replay count inconsistent with replay-chain length", () => {
  reject({ ...state(), replayCount: 2 }, /replay metadata/);
});

test("rejects a replay-last clock inconsistent with the replay head", () => {
  reject(
    {
      ...state(),
      replayLastClock: { physicalMs: 2, logical: 0, writerId: "a" },
    },
    /replay metadata/,
  );
});

test("rejects applied identities unrelated to replay history", () => {
  reject({ ...state(), applied: undefined }, /derived state/);
});

test("rejects a frontier inconsistent with replay history", () => {
  reject({ ...state(), frontier: { a: 2n } }, /derived state/);
});

const replayDuplicateState = (
  duplicate: ReturnType<typeof testOperation>,
): OperationApplyState<readonly string[]> => {
  const replayed = state();
  return {
    ...replayed,
    replayHead: { operation: duplicate, previous: replayed.replayHead },
    replayCount: 2,
  };
};

test("rejects repeated identical replay identities", () => {
  reject(
    { ...replayDuplicateState(operation), projection: ["a-1", "a-1"] },
    /replay identity/,
  );
});

test("rejects replay operation-ID and writer-sequence equivocation", () => {
  reject(
    replayDuplicateState({ ...operation, payload: "conflict" }),
    /replay identity/,
  );
});

test("rejects pending identities conflicting with applied history", () => {
  reject(
    {
      ...state(),
      pending: [{ ...operation, operationId: "other", payload: "conflict" }],
    },
    /pending identity/,
  );
});

const rejectPendingPair = (
  second: (
    pending: ReturnType<typeof testOperation>,
  ) => ReturnType<typeof testOperation>,
) => {
  const pending = testOperation("b", 2n, { b: 1n }, "pending");
  reject(
    {
      ...testApplyState<readonly string[]>([]),
      pending: [pending, second(pending)],
    },
    /pending identity/,
  );
};

test("rejects pending operation-ID equivocation", () => {
  rejectPendingPair((pending) => ({
    ...pending,
    writerId: "c",
    clock: { ...pending.clock, writerId: "c" },
    payload: "conflict",
  }));
});

test("rejects pending writer-sequence equivocation", () => {
  rejectPendingPair((pending) => ({
    ...pending,
    operationId: "other",
    payload: "conflict",
  }));
});

test("rejects repeated identical pending identities", () => {
  rejectPendingPair((pending) => pending);
});

test("rejects clocks that regress across replay and pending state", () => {
  const replayed = state();
  reject(
    {
      ...replayed,
      pending: [testOperation("a", 2n, { a: 1n }, "pending", 0)],
    },
    /strictly advance with sequence/,
  );
});

test("round trips replay depth beyond the former call-stack limit", () => {
  const depth = 25_000;
  let replayHead: OperationApplyState<readonly string[]>["replayHead"];
  const applied: Record<string, string> = {};
  const frontier: Record<string, bigint> = {};
  for (let index = 1; index <= depth; index += 1) {
    const distinct = testOperation(
      `writer-${index.toString()}`,
      1n,
      {},
      "x",
      index,
    );
    replayHead = { operation: distinct, previous: replayHead };
    const fingerprint = operationFingerprint(distinct);
    applied[`id:${distinct.operationId}`] = fingerprint;
    applied[`writer:${distinct.writerId}:1`] = fingerprint;
    frontier[distinct.writerId] = 1n;
  }
  const encoded = encodeOperationCheckpoint({
    ...testApplyState<readonly string[]>([]),
    frontier,
    applied: restoreAppliedIdentityIndex(applied),
    replayHead,
    replayCount: depth,
    replayLastClock: replayHead?.operation.clock,
  });
  expect(decodeOperationCheckpoint(encoded).replayCount).toBe(depth);
});

test("checkpoint decoding rejects negative sequence, parents, and frontiers", () => {
  const empty = testApplyState<readonly string[]>([]);
  reject({ ...empty, pending: [{ ...operation, sequence: -1n }] }, /positive/);
  reject(
    { ...empty, pending: [{ ...operation, parents: { a: -1n } }] },
    /record/,
  );
  reject({ ...empty, frontier: { a: -1n } }, /record/);
  reject({ ...empty, baseFrontier: { a: -1n } }, /record/);
});

test("checkpoint decoding rejects replay outside canonical clock order", () => {
  const ordered = applyOperationList(
    [operation, testOperation("b", 1n, {}, "y", 2)],
    testApplyState<readonly string[]>([]),
    appendOperationId,
  );
  const newest = ordered.replayHead;
  const oldest = newest?.previous;
  if (newest === undefined || oldest === undefined)
    throw new Error("Expected two replay entries");
  reject(
    {
      ...ordered,
      replayHead: {
        operation: oldest.operation,
        previous: { operation: newest.operation, previous: undefined },
      },
      replayLastClock: oldest.operation.clock,
    },
    /clock order/,
  );
});

test("negative payload bigints round trip", () => {
  const pending = { ...operation, parents: { missing: 1n }, payload: -9n };
  const decoded = decodeOperationCheckpoint(
    encodeOperationCheckpoint({
      ...testApplyState<readonly string[]>([]),
      pending: [pending],
    }),
  );
  expect(decoded.pending[0]?.payload).toBe(-9n);
});

test("checkpoint decoding rejects negative physical clocks", () => {
  const encoded = encodeOperationCheckpoint({
    ...testApplyState<readonly string[]>([]),
    replayLastClock: { physicalMs: -1, logical: 0, writerId: "a" },
  });
  expect(() => decodeOperationCheckpoint(encoded)).toThrow(
    "Invalid checkpoint clock",
  );
});
