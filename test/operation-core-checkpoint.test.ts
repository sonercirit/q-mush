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
    compactionWatermark: undefined,
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
    !(
      parsed.replayHead === undefined ||
      parsed.replayHead === null ||
      typeof parsed.replayHead === "object"
    ) ||
    !(
      !("compactionWatermark" in parsed) ||
      parsed.compactionWatermark === undefined ||
      typeof parsed.compactionWatermark === "object"
    ) ||
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
    replayHead: parseReplayEntry(parsed.replayHead),
    replayCount: parsed.replayCount,
    replayLastClock:
      parsed.replayLastClock === undefined
        ? undefined
        : parseClock(parsed.replayLastClock),
    compactionWatermark:
      "compactionWatermark" in parsed &&
      parsed.compactionWatermark !== undefined
        ? parseClock(parsed.compactionWatermark)
        : undefined,
    baseProjection: parsed.baseProjection,
    baseFrontier: bigintRecord(parsed.baseFrontier),
  };
};
const parseReplayEntry = (
  value: unknown,
): OperationApplyState<unknown>["replayHead"] => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || !("operation" in value))
    throw new Error("Invalid replay entry");
  return {
    operation: parseOperation(value.operation),
    previous: parseReplayEntry(
      "previous" in value ? value.previous : undefined,
    ),
  };
};
const parseOperation = (value: unknown): Operation => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operationId" in value) ||
    typeof value.operationId !== "string" ||
    !("schemaVersion" in value) ||
    typeof value.schemaVersion !== "number" ||
    !("writerId" in value) ||
    typeof value.writerId !== "string" ||
    !("sequence" in value) ||
    typeof value.sequence !== "bigint" ||
    !("clock" in value) ||
    typeof value.clock !== "object" ||
    value.clock === null ||
    !("physicalMs" in value.clock) ||
    typeof value.clock.physicalMs !== "number" ||
    !("logical" in value.clock) ||
    typeof value.clock.logical !== "number" ||
    !("writerId" in value.clock) ||
    typeof value.clock.writerId !== "string" ||
    !("parents" in value) ||
    typeof value.parents !== "object" ||
    value.parents === null ||
    !("entity" in value) ||
    typeof value.entity !== "object" ||
    value.entity === null ||
    !("type" in value.entity) ||
    typeof value.entity.type !== "string" ||
    !("id" in value.entity) ||
    typeof value.entity.id !== "string" ||
    !("accountId" in value.entity) ||
    typeof value.entity.accountId !== "string" ||
    !("kind" in value) ||
    typeof value.kind !== "string" ||
    !("payload" in value)
  )
    throw new Error("Invalid replay operation");
  return createOperation({
    operationId: value.operationId,
    schemaVersion: value.schemaVersion,
    writerId: value.writerId,
    sequence: value.sequence,
    clock: {
      physicalMs: value.clock.physicalMs,
      logical: value.clock.logical,
      writerId: value.clock.writerId,
    },
    parents: bigintRecord(value.parents),
    entity: {
      type: value.entity.type,
      id: value.entity.id,
      accountId: value.entity.accountId,
    },
    kind: value.kind,
    payload: value.payload,
  });
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

  test("rejects operations older than a compacted watermark", () => {
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
    const pending = applyOperation(
      state,
      operation("c", 2n, { c: 1n }, "pending", 201),
      append,
    );
    expect(() => compactOperationState(pending, pending.frontier)).toThrow(
      /empty pending buffer/,
    );
    const compacted = compactOperationState(state, state.frontier);
    expect(compacted.replayCount).toBe(0);
    expect(() => compactOperationState(state, { a: 100n })).toThrow(/equal/);
    expect(compacted.baseProjection).toEqual(state.projection);
    expect(compacted.baseFrontier).toEqual(state.frontier);
    expect(compacted.compactionWatermark).toEqual(state.replayLastClock);
    expect(() =>
      applyOperation(compacted, operation("b", 1n, {}, "late", 1), append),
    ).toThrow(/compaction watermark/);
  });

  test("round trips replay history and converges after out-of-order arrival", () => {
    const a1 = operation("a", 1n, {}, "a", 100);
    const a2 = operation("a", 2n, { a: 1n }, "a", 110);
    const b1 = operation("b", 1n, {}, "b", 50);
    const beforeLate = applyOperation(
      applyOperation(arrayState(), a1, append),
      a2,
      append,
    );
    const restored = applyOperation(roundTrip(beforeLate), b1, append);
    const continuous = applyOperation(beforeLate, b1, append);
    expect(restored.projection).toEqual(continuous.projection);
    expect(restored.frontier).toEqual(continuous.frontier);
  });
});
