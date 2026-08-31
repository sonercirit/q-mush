import { describe, expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import {
  appendOperationId,
  applyOperationList,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";
import { stableArrayState } from "./operation-stability-test-support";

const decodeTagged = (encoded: string): [string, unknown][] => {
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1]))
    throw new Error("Invalid fixture");
  return parsed[1].flatMap((entry): [string, unknown][] =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      ? [[entry[0], entry[1]]]
      : [],
  );
};
const withoutStableClock = (encoded: string): string => {
  const parsed: unknown = JSON.parse(encoded);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[1]))
    throw new Error("Invalid fixture");
  parsed[1] = parsed[1].filter(
    (entry) => Array.isArray(entry) && entry[0] !== "stableClock",
  );
  return JSON.stringify(parsed);
};

describe("stable checkpoint codec", () => {
  const stableState = stableArrayState;

  test("round trips the tenth stableClock field", () => {
    const encoded = encodeOperationCheckpoint(stableState());
    expect(decodeTagged(encoded)).toHaveLength(10);
    expect(decodeOperationCheckpoint(encoded).stableClock).toEqual({
      physicalMs: 10,
      logical: 0,
      writerId: "a",
    });
  });

  test("accepts legacy nine-field checkpoints as unstable", () => {
    const encoded = withoutStableClock(
      encodeOperationCheckpoint(testApplyState<readonly string[]>([])),
    );
    expect(decodeTagged(encoded)).toHaveLength(9);
    expect(decodeOperationCheckpoint(encoded).stableClock).toBeUndefined();
  });

  test("rejects malformed stable clocks and field counts", () => {
    const state = stableState();
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({
          ...state,
          stableClock: { physicalMs: -1, logical: 0, writerId: "a" },
        }),
      ),
    ).toThrow(/clock/);
    const encoded: unknown = JSON.parse(encodeOperationCheckpoint(state));
    if (!Array.isArray(encoded) || !Array.isArray(encoded[1]))
      throw new Error("Invalid fixture");
    encoded[1].push(["extra", ["primitive", null]]);
    expect(() => decodeOperationCheckpoint(JSON.stringify(encoded))).toThrow(
      /fields/,
    );
  });

  test("requires stableClock exactly with a nonempty base frontier", () => {
    const empty = testApplyState<readonly string[]>([]);
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({
          ...empty,
          stableClock: { physicalMs: 1, logical: 0, writerId: "a" },
        }),
      ),
    ).toThrow(/stable frontier/);
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({ ...empty, baseFrontier: { a: 1n } }),
      ),
    ).toThrow(/stable frontier/);
  });

  test("requires the stable writer in base and later replay and pending clocks", () => {
    const state = stableState();
    const stableClock = state.stableClock;
    if (stableClock === undefined) throw new Error("Missing stable fixture");
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({
          ...state,
          stableClock: { ...stableClock, writerId: "missing" },
        }),
      ),
    ).toThrow(/stable writer/);
    const replay = applyOperationList(
      [testOperation("a", 1n, {}, "a", 10)],
      testApplyState<readonly string[]>([]),
      appendOperationId,
    );
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({
          ...replay,
          baseFrontier: { a: 0n },
          stableClock: replay.replayLastClock,
        }),
      ),
    ).toThrow(/stable clock order/);
    expect(() =>
      decodeOperationCheckpoint(
        encodeOperationCheckpoint({
          ...state,
          pending: [testOperation("0", 2n, { "0": 1n }, "pending", 10)],
        }),
      ),
    ).toThrow(/stable clock order/);
  });
});
