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

  test("apply uses full envelope validation and stores its snapshot", () => {
    const invalid: ReturnType<typeof testOperation> = {
      ...seed,
      entity: Object.defineProperty({ ...seed.entity }, "workspaceId", {
        enumerable: true,
        value: undefined,
      }),
    };
    expect(() =>
      applyOperation(
        testApplyState<readonly string[]>([]),
        invalid,
        appendOperationId,
      ),
    ).toThrow(/workspaceId/);
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
