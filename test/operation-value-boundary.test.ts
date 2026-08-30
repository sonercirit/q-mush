import { describe, expect, test } from "vitest";

import {
  decodeOperationEnvelope,
  encodeOperationEnvelope,
} from "../shared/operation-checkpoint";
import {
  applyOperation,
  createOperation,
  operationFingerprint,
} from "../shared/operation-core";
import {
  appendOperationId,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";

const seed = testOperation("accessor", 1n, {}, "value", 1);
const rejectPayload = (payload: unknown): void => {
  expect(() => createOperation({ ...seed, payload })).toThrow(
    /data properties/,
  );
};

test("operation admission requires codec-exact structural keys and round trips", () => {
  const operation = testOperation("writer-a", 1n, {}, "one");
  for (const candidate of [
    { ...operation, extra: true },
    { ...operation, clock: { ...operation.clock, extra: true } },
    { ...operation, entity: { ...operation.entity, extra: true } },
  ])
    expect(() => createOperation(candidate)).toThrow(/exact keys/);
  const accepted = createOperation(operation);
  expect(decodeOperationEnvelope(encodeOperationEnvelope(accepted))).toEqual(
    accepted,
  );
});

describe("operation read-once value boundary", () => {
  test("rejects getters, setters, and nested or array accessors", () => {
    const getter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    const setter = Object.defineProperty({}, "value", {
      enumerable: true,
      set: () => undefined,
    });
    const nested = { child: getter };
    const array = [1];
    Object.defineProperty(array, "0", { enumerable: true, get: () => 1 });
    for (const payload of [getter, setter, nested, array])
      rejectPayload(payload);
  });

  test("snapshots a descriptor proxy once for stable fingerprint and encoding", () => {
    let reads = 0;
    const payload = new Proxy(
      { value: 0 },
      {
        getOwnPropertyDescriptor(_target, property) {
          if (property === "value") {
            reads += 1;
            return {
              configurable: true,
              enumerable: true,
              value: reads,
              writable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(_target, property);
        },
      },
    );
    const accepted = createOperation({ ...seed, payload });
    expect(reads).toBe(1);
    const first = operationFingerprint(accepted);
    expect(operationFingerprint(accepted)).toBe(first);
    const decoded = decodeOperationEnvelope(encodeOperationEnvelope(accepted));
    expect(operationFingerprint(decoded)).toBe(first);
    expect(decoded.payload).toEqual({ value: 1 });
  });

  test("apply snapshots every envelope property once and stores plain snapshot data", () => {
    const reads = new Map<PropertyKey, number>();
    const candidate = new Proxy(seed, {
      getOwnPropertyDescriptor(target, property) {
        reads.set(property, (reads.get(property) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const state = applyOperation(
      testApplyState<readonly string[]>([]),
      candidate,
      appendOperationId,
    );
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(state.replayHead?.operation).not.toBe(candidate);
    expect(state.replayHead?.operation).toEqual(seed);
  });

  test("rejects operation values that are not reference-free trees", () => {
    const shared = { value: 1 };
    expect(() =>
      createOperation({ ...seed, payload: { left: shared, right: shared } }),
    ).toThrow(/reference-free trees/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => createOperation({ ...seed, payload: cyclic })).toThrow(
      /reference-free trees/,
    );
    expect(
      createOperation({
        ...seed,
        payload: { repeated: [1, 1], distinct: [{ value: 1 }, { value: 1 }] },
      }).payload,
    ).toEqual({
      repeated: [1, 1],
      distinct: [{ value: 1 }, { value: 1 }],
    });
  });

  test("rejects a clean Date with a derived prototype", () => {
    const derivedPrototype = Reflect.construct(Object, []);
    Object.setPrototypeOf(derivedPrototype, Date.prototype);
    const derived = new Date(1);
    Object.setPrototypeOf(derived, derivedPrototype);
    expect(() => createOperation({ ...seed, payload: derived })).toThrow(
      /own properties/,
    );
  });
});
