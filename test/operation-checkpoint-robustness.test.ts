import { expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import type { OperationApplyState } from "../shared/operation-core";
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

test("round trips replay depth beyond the former call-stack limit", () => {
  const depth = 25_000;
  const seed = state();
  let replayHead = seed.replayHead;
  for (let index = 1; index < depth; index += 1)
    replayHead = { operation, previous: replayHead };
  const encoded = encodeOperationCheckpoint({
    ...seed,
    replayHead,
    replayCount: depth,
  });
  expect(decodeOperationCheckpoint(encoded).replayCount).toBe(depth);
});
