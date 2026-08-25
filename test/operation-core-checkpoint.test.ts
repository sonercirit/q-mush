import { describe, expect, test } from "vitest";
import {
  applyOperation,
  compactOperationState,
  createOperation,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";

const operation = (
  writerId: string,
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  value: string,
  physicalMs: number,
) =>
  createOperation({
    operationId: `${writerId}-${sequence.toString()}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: { physicalMs, logical: 0, writerId },
    parents,
    entity: { type: "workspaces", id: "w", accountId: "a" },
    kind: "workspace.name.set",
    payload: { value },
  });
const arrayState = (): OperationApplyState<readonly string[]> => {
  const projection: readonly string[] = [];
  return {
    frontier: {},
    pending: [],
    projection,
    applied: {},
    replayHead: undefined,
    replayCount: 0,
    replayLastClock: undefined,
    baseProjection: projection,
    baseFrontier: {},
  };
};
const append = (projection: readonly string[], item: Operation) => [
  ...projection,
  item.operationId,
];
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
const bigintRecord = (value: object): Readonly<Record<string, bigint>> =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, bigint] => typeof entry[1] === "bigint",
    ),
  );
const roundTrip = (
  state: OperationApplyState<readonly string[]>,
): OperationApplyState<readonly string[]> => {
  const parsed: unknown = JSON.parse(
    JSON.stringify(state, (_key, value: unknown) =>
      typeof value === "bigint" ? `${value.toString()}n` : value,
    ),
    (_key, value: unknown) =>
      typeof value === "string" && /^\d+n$/.test(value)
        ? BigInt(value.slice(0, -1))
        : value,
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("frontier" in parsed) ||
    !("pending" in parsed) ||
    !("projection" in parsed) ||
    !("applied" in parsed) ||
    !("replayHead" in parsed) ||
    !("replayCount" in parsed) ||
    !("replayLastClock" in parsed) ||
    !("baseProjection" in parsed) ||
    !("baseFrontier" in parsed) ||
    !Array.isArray(parsed.pending) ||
    !Array.isArray(parsed.projection) ||
    !Array.isArray(parsed.baseProjection) ||
    typeof parsed.frontier !== "object" ||
    parsed.frontier === null ||
    typeof parsed.applied !== "object" ||
    parsed.applied === null ||
    typeof parsed.replayCount !== "number" ||
    typeof parsed.baseFrontier !== "object" ||
    parsed.baseFrontier === null
  )
    throw new Error("Invalid checkpoint");
  return {
    frontier: bigintRecord(parsed.frontier),
    pending: parsed.pending,
    projection: parsed.projection,
    applied: Object.fromEntries(
      Object.entries(parsed.applied).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    replayHead: undefined,
    replayCount: parsed.replayCount,
    replayLastClock:
      parsed.replayLastClock === undefined
        ? undefined
        : parseClock(parsed.replayLastClock),
    baseProjection: parsed.baseProjection,
    baseFrontier: bigintRecord(parsed.baseFrontier),
  };
};
const parseClock = (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("physicalMs" in value) ||
    !("logical" in value) ||
    !("writerId" in value) ||
    typeof value.physicalMs !== "number" ||
    typeof value.logical !== "number" ||
    typeof value.writerId !== "string"
  )
    throw new Error("Invalid clock");
  return {
    physicalMs: value.physicalMs,
    logical: value.logical,
    writerId: value.writerId,
  };
};

describe("operation checkpoints", () => {
  test("serializes complete checkpoints and rejects resent equivocation", () => {
    let state = arrayState();
    for (let sequence = 1; sequence <= 3; sequence += 1)
      state = applyOperation(state, sequentialOperation("a", sequence), append);
    const checkpoint = roundTrip(state);
    expect(Object.keys(checkpoint.applied)).toHaveLength(6);
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

  test("accepts a writer clock reset and checkpoint compaction bounds replay", () => {
    let state = arrayState();
    const stream = Array.from({ length: 100 }, (_, index) =>
      sequentialOperation("a", index + 1, 1_000),
    );
    state = stream.reduce(
      (current, item) => applyOperation(current, item, append),
      state,
    );
    state = applyOperation(
      state,
      operation("a", 101n, { a: 100n }, "x", 900),
      append,
    );
    const compacted = compactOperationState(state, state.frontier);
    expect(compacted.replayCount).toBe(0);
    expect(() => compactOperationState(state, { a: 100n })).toThrow(/equal/);
    const lateCounter = { calls: 0 };
    const late = applyOperation(
      compacted,
      operation("b", 1n, {}, "late", 1),
      (projection, item) => {
        lateCounter.calls += 1;
        return append(projection, item);
      },
    );
    expect(lateCounter.calls).toBe(1);
    expect(late.replayCount).toBe(1);
  });
});
