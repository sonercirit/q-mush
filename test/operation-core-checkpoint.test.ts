import { describe, expect, test } from "vitest";

import {
  appendOperationId,
  applyOperationList,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";

import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import {
  applyOperation,
  materializeApplied,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";

const operation = testOperation;
const arrayState = () => testApplyState<readonly string[]>([]);
const append = appendOperationId;
const applyAll = (
  items: readonly Operation[],
  state = arrayState(),
): OperationApplyState<readonly string[]> =>
  applyOperationList(items, state, append);
const concurrentPair = () =>
  [operation("a", 1n, {}, "a", 100), operation("b", 1n, {}, "b", 50)] as const;
const sequentialOperation = (
  writer: string,
  sequence: number,
  clock = sequence,
) =>
  operation(
    writer,
    BigInt(sequence),
    sequence === 1 ? {} : { [writer]: BigInt(sequence - 1) },
    "x",
    clock,
  );
const requireArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("Missing array fixture");
  return value;
};
const requireEntry = (value: unknown, field: string): unknown[] => {
  const entry = requireArray(value).find(
    (candidate) => Array.isArray(candidate) && candidate[0] === field,
  );
  if (!Array.isArray(entry)) throw new Error(`Missing ${field} fixture`);
  return entry;
};
const roundTrip = (
  state: OperationApplyState<readonly string[]>,
): OperationApplyState<readonly string[]> =>
  decodeOperationCheckpoint(encodeOperationCheckpoint(state));

describe("operation checkpoints", () => {
  test("rejects encoded prototype object entries without prototype mutation", () => {
    const encoded = JSON.stringify([
      "object",
      [["__proto__", ["primitive", "value"]]],
    ]);
    expect(() => decodeOperationCheckpoint(encoded)).toThrow(/checkpoint/);
  });

  test("serializes complete checkpoints and rejects resent equivocation", () => {
    let state = arrayState();
    for (let sequence = 1; sequence <= 3; sequence += 1)
      state = applyOperation(state, sequentialOperation("a", sequence), append);
    const checkpoint = roundTrip(state);
    expect(Object.keys(materializeApplied(checkpoint.applied))).toHaveLength(6);
    expect(
      applyOperation(checkpoint, sequentialOperation("a", 1), append),
    ).toBe(checkpoint);
    expect(() =>
      applyOperation(
        checkpoint,
        { ...sequentialOperation("a", 1), payload: { value: "altered" } },
        append,
      ),
    ).toThrow(/equivocation/);
  });

  test("does not admit a decoded checkpoint with duplicate reducer effects", () => {
    const pending = sequentialOperation("a", 2);
    const encoded = encodeOperationCheckpoint({
      ...arrayState(),
      pending: [pending, pending],
    });
    let reducerCalls = 0;
    expect(() => {
      const restored = decodeOperationCheckpoint(encoded);
      applyOperation(restored, sequentialOperation("a", 1), (projection) => {
        reducerCalls += 1;
        return projection;
      });
    }).toThrow(/pending identity/);
    expect(reducerCalls).toBe(0);
  });

  test("orders simultaneously released children independently of arrival", () => {
    const append = (projection: string, item: Operation) =>
      `${projection}${item.operationId}`;
    const parent = operation("a", 1n, {}, "a", 10);
    const early = operation("b", 1n, { a: 1n }, "b", 20);
    const late = operation("c", 1n, { a: 1n }, "c", 30);
    const run = (items: readonly Operation[]) =>
      items.reduce((state, item) => applyOperation(state, item, append), {
        ...arrayState(),
        projection: "",
        baseProjection: "",
      });
    expect(run([late, early, parent]).projection).toBe(
      run([early, late, parent]).projection,
    );
  });

  test("replays twice from the stable base with an order-sensitive reducer", () => {
    const empty = arrayState();
    const a = applyOperation(empty, operation("a", 1n, {}, "a", 100), append);
    const b = applyOperation(a, operation("b", 1n, {}, "b", 50), append);
    const c = applyOperation(b, operation("c", 1n, {}, "c", 60), append);
    expect(c.projection).toEqual(["b-1", "c-1", "a-1"]);
  });

  test("preserves adversarial payload structures through checkpoints", () => {
    const payloads = [
      { nested: ["123n", { value: "456n" }] },
      { bigint: "structural key", array: { object: "primitive" } },
      ["bigint", "123"],
      ["array", ["primitive", "x"]],
      ["object", [["value", ["bigint", "123"]]]],
    ];
    for (const payload of payloads) {
      const item = { ...operation("a", 1n, {}, "x", 1), payload };
      const checkpoint = roundTrip(applyOperation(arrayState(), item, append));
      expect(checkpoint.replayHead?.operation.payload).toEqual(payload);
    }
  });

  test("rejects malformed and extra checkpoint fields at every level", () => {
    const state = applyAll([sequentialOperation("a", 1)]);
    const decoded: unknown = JSON.parse(encodeOperationCheckpoint(state));
    const decodedArray = requireArray(decoded);
    const objectEntries = requireArray(decodedArray[1]);
    const change = (field: string, replacement: unknown) => [
      decodedArray[0],
      objectEntries.map((entry) => {
        const pair = requireArray(entry);
        return pair[0] === field ? [field, replacement] : pair;
      }),
    ];
    const encodedPrimitive = (value: unknown) => ["primitive", value];
    const pendingState = applyOperation(
      arrayState(),
      sequentialOperation("a", 2),
      append,
    );
    const pendingDecoded: unknown = JSON.parse(
      encodeOperationCheckpoint(pendingState),
    );
    const pendingOperationEntries = (value: unknown): unknown[] => {
      const rootEntries = requireArray(requireArray(value)[1]);
      const pendingEntry = requireEntry(rootEntries, "pending");
      const operations = requireArray(requireArray(pendingEntry[1])[1]);
      return requireArray(requireArray(operations[0])[1]);
    };
    const pendingCopy = (): unknown => structuredClone(pendingDecoded);
    const mutatePending = (
      field: string,
      replacement: unknown,
      nested = false,
    ) => {
      const copy = pendingCopy();
      const entries = pendingOperationEntries(copy);
      const target = nested
        ? requireArray(requireArray(requireEntry(entries, "clock")[1])[1])
        : entries;
      requireEntry(target, field)[1] = replacement;
      return copy;
    };
    const malformedClockWriter = structuredClone(pendingDecoded);
    const clockEntry = requireEntry(
      pendingOperationEntries(malformedClockWriter),
      "clock",
    );
    requireEntry(requireArray(requireArray(clockEntry[1])[1]), "writerId")[1] =
      encodedPrimitive(42);
    const duplicateObjectKey = structuredClone(decoded);
    requireArray(requireArray(duplicateObjectKey)[1]).push(objectEntries[0]);
    const wrongStateKeys = structuredClone(decoded);
    const wrongEntries = requireArray(requireArray(wrongStateKeys)[1]);
    wrongEntries.splice(0, 1, ["unexpected", encodedPrimitive(true)]);
    const mutations: unknown[] = [
      [decodedArray[0], [...objectEntries, ["extra", encodedPrimitive(true)]]],
      change("frontier", ["object", [["a", encodedPrimitive("1")]]]),
      change("applied", ["object", [["key", ["bigint", "1"]]]]),
      change("projection", ["array", [["primitive", 42]]]),
      change("baseProjection", ["array", [["primitive", 42]]]),
      mutatePending("payload", ["object", [[1, encodedPrimitive("x")]]]),
      mutatePending("schemaVersion", encodedPrimitive("1")),
      mutatePending("schemaVersion", encodedPrimitive(true)),
      mutatePending("schemaVersion", encodedPrimitive(1e300)),
      mutatePending("physicalMs", encodedPrimitive("1"), true),
      mutatePending("logical", encodedPrimitive(-1), true),
      mutatePending("logical", encodedPrimitive(1.5), true),
      mutatePending("logical", encodedPrimitive(1e300), true),
      mutatePending("partition", encodedPrimitive("session")),
      mutatePending("payload", ["date", "2024-01-01"]),
      malformedClockWriter,
      duplicateObjectKey,
      wrongStateKeys,
      change("pending", encodedPrimitive(null)),
      change("replayCount", encodedPrimitive(-1)),
      change("replayCount", encodedPrimitive(1e300)),
      mutatePending("sequence", ["bigint", "01"]),
      mutatePending("sequence", ["date", "2024-01-01"]),
    ];
    const wrongReplayKey = structuredClone(decoded);
    const replayHead = requireEntry(
      requireArray(requireArray(wrongReplayKey)[1]),
      "replayHead",
    );
    const replayItems = requireArray(replayHead[1]);
    replayItems.push(encodedPrimitive(null));
    mutations.push(wrongReplayKey);
    // Target nested records rather than only the operation itself.
    for (const field of ["clock", "entity"] as const) {
      const copy = structuredClone(pendingDecoded);
      const operationEntries = pendingOperationEntries(copy);
      const nestedEntry = requireEntry(operationEntries, field);
      const nested = requireArray(requireArray(nestedEntry[1])[1]);
      nested.push(["extra", encodedPrimitive(true)]);
      mutations.push(copy);
    }
    for (const mutation of mutations)
      expect(() => decodeOperationCheckpoint(JSON.stringify(mutation))).toThrow(
        /Invalid/,
      );
  });

  test("preserves Date payload fingerprints through production checkpoints", () => {
    const item = {
      ...sequentialOperation("a", 1),
      payload: { at: new Date(5) },
    };
    const restored = roundTrip(applyOperation(arrayState(), item, append));
    expect(restored.replayHead?.operation.payload).toEqual({ at: new Date(5) });
    expect(applyOperation(restored, item, append)).toBe(restored);
  });

  test("round trips pending operations and releases them after restart", () => {
    const a1 = sequentialOperation("a", 1, 10);
    const a2 = sequentialOperation("a", 2, 20);
    const a3 = sequentialOperation("a", 3, 30);
    const waiting = applyOperation(arrayState(), a3, append);
    const restored = roundTrip(waiting);
    expect(restored.pending).toEqual([a3]);
    const complete = applyAll([a1, a2], restored);
    const expectedProjection = ["a-1", "a-2", "a-3"];
    expect(complete).toMatchObject({
      projection: expectedProjection,
      frontier: { a: 3n },
    });
    expect(applyOperation(complete, a3, append)).toBe(complete);
  });

  test("rejects a regressing same-writer clock", () => {
    const a1 = sequentialOperation("a", 1, 100);
    const a2 = sequentialOperation("a", 2, 50);
    const state = applyAll([a1]);
    expect(() => applyOperation(state, a2, append)).toThrow(
      /clock must strictly advance/,
    );
    expect(state.projection).toEqual(["a-1"]);
    expect(state.frontier).toEqual({ a: 1n });
  });

  test("accepts a concurrent earlier-clock operation and converges", () => {
    const [a1, b1] = concurrentPair();
    const late = applyAll([b1], roundTrip(applyAll([a1])));
    const early = applyAll([b1, a1]);
    expect(late.projection).toEqual(early.projection);
    expect(late.frontier).toEqual(early.frontier);
  });

  test("makes identical redelivery a no-op after reordering and checkpointing", () => {
    const [a1, b1] = concurrentPair();
    const reordered = applyAll([a1, b1]);
    expect(applyOperation(reordered, a1, append)).toBe(reordered);
    const restored = roundTrip(reordered);
    expect(applyOperation(restored, b1, append)).toBe(restored);
  });

  test("round trips replay history and converges after out-of-order arrival", () => {
    const [a1, b1] = concurrentPair();
    const a2 = operation("a", 2n, { a: 1n }, "a", 110);
    const beforeLate = applyAll([a1, a2]);
    const restored = applyOperation(roundTrip(beforeLate), b1, append);
    const continuous = applyOperation(beforeLate, b1, append);
    expect(restored.projection).toEqual(continuous.projection);
    expect(restored.frontier).toEqual(continuous.frontier);
  });
});
