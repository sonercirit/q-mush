import { describe, expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  decodeOperationEnvelope,
  encodeOperationCheckpoint,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  createOperation,
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
const decoded = (checkpoint: OperationApplyState<readonly string[]>) =>
  decodeOperationCheckpoint(encodeOperationCheckpoint(checkpoint));
const reject = (
  checkpoint: OperationApplyState<readonly string[]>,
  pattern: RegExp,
) => {
  expect(() => decoded(checkpoint)).toThrow(pattern);
};

test("operation envelopes reject encoded negative zero and preserve zero", () => {
  const zero = { ...operation, payload: { nested: 0 } };
  const encoded = encodeOperationEnvelope(zero);
  expect(decodeOperationEnvelope(encoded).payload).toEqual({ nested: 0 });
  const negativeZero = encoded.replace('["primitive",0]', '["primitive",-0]');
  expect(negativeZero).not.toBe(encoded);
  expect(() => decodeOperationEnvelope(negativeZero)).toThrow(
    /operation envelope/,
  );
});

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

test("accepts contiguous replay above a non-empty base with parents covered after resort", () => {
  const base = {
    ...testApplyState<readonly string[]>(["base"]),
    frontier: { a: 5n },
    baseFrontier: { a: 5n },
  };
  const child = testOperation("b", 1n, { a: 6n }, "child", 1);
  const parent = testOperation("a", 6n, { a: 5n }, "parent", 10);
  const replayed = applyOperationList([child, parent], base, appendOperationId);
  expect(decoded(replayed).projection).toEqual(["base", "b-1", "a-6"]);
  expect(decoded(replayed).frontier).toEqual({ a: 6n, b: 1n });
});

const singleReplayState = (
  replayed: ReturnType<typeof testOperation>,
): OperationApplyState<readonly string[]> => {
  const fingerprint = operationFingerprint(replayed);
  return {
    ...testApplyState<readonly string[]>([]),
    frontier: { [replayed.writerId]: replayed.sequence },
    projection: [replayed.operationId],
    applied: restoreAppliedIdentityIndex({
      [`id:${replayed.operationId}`]: fingerprint,
      [`writer:${replayed.writerId}:${replayed.sequence.toString()}`]:
        fingerprint,
    }),
    replayHead: { operation: replayed, previous: undefined },
    replayCount: 1,
    replayLastClock: replayed.clock,
  };
};

test("rejects a replay writer-sequence gap above the base frontier", () => {
  reject(
    singleReplayState(testOperation("a", 2n, {}, "x", 2)),
    /replay sequence/,
  );
});

test("rejects a replay writer-sequence gap of more than one", () => {
  reject(
    singleReplayState(testOperation("a", 3n, {}, "x", 3)),
    /replay sequence/,
  );
});

test("rejects a replay operation with an uncovered cross-writer parent", () => {
  reject(
    singleReplayState(testOperation("a", 1n, { b: 1n }, "x", 1)),
    /replay parent/,
  );
});

test("rejects a replay parent exceeding coverage by more than one", () => {
  reject(
    singleReplayState(testOperation("a", 1n, { b: 2n }, "x", 1)),
    /replay parent/,
  );
});

test("rejects a replay operation that parents itself", () => {
  const replayed = testOperation("a", 1n, {}, "x", 1);
  reject(
    singleReplayState({ ...replayed, parents: { a: 1n } }),
    /replay parent/,
  );
});

test("rejects a replay future own-writer parent covered by later replay", () => {
  const first = testOperation("a", 1n, {}, "first", 1);
  const second = testOperation("a", 2n, { a: 1n }, "second", 2);
  const replayed = applyOperationList(
    [first, second],
    testApplyState<readonly string[]>([]),
    appendOperationId,
  );
  const invalidFirst = { ...first, parents: { a: 2n } };
  const firstFingerprint = operationFingerprint(invalidFirst);
  const secondFingerprint = operationFingerprint(second);
  reject(
    {
      ...replayed,
      applied: restoreAppliedIdentityIndex({
        "id:a-1": firstFingerprint,
        "writer:a:1": firstFingerprint,
        "id:a-2": secondFingerprint,
        "writer:a:2": secondFingerprint,
      }),
      replayHead: {
        operation: second,
        previous: {
          operation: invalidFirst,
          previous: undefined,
        },
      },
    },
    /replay parent/,
  );
});

test("rejects a pending operation that parents itself", () => {
  const pending = {
    ...testOperation("self-parent-writer", 7n, {}, "impossible", 7),
    parents: { "self-parent-writer": 7n },
  };
  const checkpoint = testApplyState<readonly string[]>(["unchanged"]);
  reject({ ...checkpoint, pending: [pending] }, /pending parent/);
});

test("checkpoint decoding ignores inherited own-writer parent entries", () => {
  const writerId = "inherited-checkpoint-parent";
  const pending = testOperation(writerId, 1n, { missing: 1n }, "pending", 1);
  const checkpoint = testApplyState<readonly string[]>([]);
  const encoded = encodeOperationCheckpoint(
    Object.assign(checkpoint, { pending: [pending] }),
  );
  const inheritedParentDescriptor: PropertyDescriptor = {
    configurable: true,
    get: () => {
      throw new Error("consulted inherited parent");
    },
  };
  Reflect.defineProperty(Object.prototype, writerId, inheritedParentDescriptor);
  try {
    expect(decodeOperationCheckpoint(encoded).pending[0]?.writerId).toBe(
      writerId,
    );
  } finally {
    Reflect.deleteProperty(Object.prototype, writerId);
  }
});

test("accepts an own-writer parent at the preceding sequence end-to-end", () => {
  const replayed = applyOperationList(
    [
      testOperation("a", 1n, {}, "first", 1),
      testOperation("a", 2n, { a: 1n }, "second", 2),
    ],
    testApplyState<readonly string[]>([]),
    appendOperationId,
  );
  expect(decoded(replayed).frontier).toEqual({ a: 2n });
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

describe("operation value domain", () => {
  test("rejects values the canonical codec cannot preserve", () => {
    const seed = testOperation("shape", 1n, {}, "seed");
    const symbol = Symbol("extra");
    const arrayWithStringProperty = [1];
    Object.defineProperty(arrayWithStringProperty, "extra", { value: "lost" });
    const arrayWithSymbol = [1];
    Object.defineProperty(arrayWithSymbol, symbol, { value: "lost" });
    const dateWithProperty = new Date(1);
    Object.defineProperty(dateWithProperty, "extra", { value: "lost" });
    const dateWithSymbol = new Date(1);
    Object.defineProperty(dateWithSymbol, symbol, { value: "lost" });
    const hiddenObject = { visible: true };
    Object.defineProperty(hiddenObject, "hidden", { value: "lost" });
    const symbolObject = { visible: true };
    Object.defineProperty(symbolObject, symbol, { value: "lost" });

    for (const payload of [
      -0,
      [-0],
      { nested: -0 },
      { nested: arrayWithStringProperty },
      { nested: arrayWithSymbol },
      { nested: dateWithProperty },
      { nested: dateWithSymbol },
      { nested: hiddenObject },
      { nested: symbolObject },
    ])
      expect(() => createOperation({ ...seed, payload })).toThrow();

    for (const payload of [0, [0], { nested: 0 }, [1], new Date(1), { a: 1 }])
      expect(createOperation({ ...seed, payload }).payload).toBe(payload);
  });

  test("rejects undefined workspace IDs and round-trips accepted entities", () => {
    const seed = testOperation("workspace", 1n, {}, "seed");
    const entity = { ...seed.entity };
    Object.defineProperty(entity, "workspaceId", {
      enumerable: true,
      value: undefined,
    });
    expect(() => createOperation({ ...seed, entity })).toThrow(/workspaceId/);

    for (const acceptedEntity of [
      seed.entity,
      { ...seed.entity, workspaceId: "workspace-1" },
    ]) {
      const created = createOperation({ ...seed, entity: acceptedEntity });
      expect(decodeOperationEnvelope(encodeOperationEnvelope(created))).toEqual(
        created,
      );
    }
  });
});
