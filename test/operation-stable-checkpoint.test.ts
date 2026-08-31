import { describe, expect, test } from "vitest";

import {
  decodeOperationCheckpoint,
  encodeOperationCheckpoint,
} from "../shared/operation-checkpoint";
import {
  expectCheckpointRejection,
  mapTaggedCheckpointEntries,
  taggedCheckpointEntries,
} from "./operation-checkpoint-test-support";
import {
  applyOperationIds,
  testApplyState,
  testOperation,
} from "./operation-core-test-support";
import {
  invalidStableBaseStates,
  stabilityClock,
  stableArrayState,
} from "./operation-stability-test-support";

const decodeTagged = (encoded: string): [string, unknown][] =>
  taggedCheckpointEntries(encoded).flatMap((entry): [string, unknown][] =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
      ? [[entry[0], entry[1]]]
      : [],
  );
const withoutStableClock = (encoded: string): string =>
  mapTaggedCheckpointEntries(encoded, (entries) =>
    entries.filter(
      (entry) => Array.isArray(entry) && entry[0] !== "stableClock",
    ),
  );

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
          stableClock: stabilityClock(-1, "a"),
        }),
      ),
    ).toThrow(/clock/);
    const encoded = mapTaggedCheckpointEntries(
      encodeOperationCheckpoint(state),
      (entries) => [...entries, ["extra", ["primitive", null]]],
    );
    expect(() => decodeOperationCheckpoint(encoded)).toThrow(/fields/);
  });

  test("requires stableClock exactly with a nonempty base frontier", () => {
    for (const invalid of invalidStableBaseStates())
      expectCheckpointRejection(invalid, /stable frontier/);
  });

  test("requires the stable writer in base and later replay and pending clocks", () => {
    const state = stableState();
    const stableClock = state.stableClock;
    if (stableClock === undefined) throw new Error("Missing stable fixture");
    expectCheckpointRejection(
      {
        ...state,
        stableClock: { ...stableClock, writerId: "missing" },
      },
      /stable writer/,
    );
    const replay = applyOperationIds([testOperation("a", 1n, {}, "a", 10)]);
    expectCheckpointRejection(
      {
        ...replay,
        baseFrontier: { a: 0n },
        stableClock: replay.replayLastClock,
      },
      /stable clock order/,
    );
    expectCheckpointRejection(
      {
        ...state,
        pending: [testOperation("0", 2n, { "0": 1n }, "pending", 10)],
      },
      /stable clock order/,
    );
  });
});
