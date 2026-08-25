import { describe, expect, test } from "vitest";
import {
  applyOperation,
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
const applyAll = (
  items: readonly Operation[],
  state = arrayState(),
): OperationApplyState<readonly string[]> =>
  items.reduce((current, item) => applyOperation(current, item, append), state);
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
const parseBigintRecord = (
  value: unknown,
): Readonly<Record<string, bigint>> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "bigint")
  )
    throw new Error("Invalid bigint record");
  return Object.fromEntries(Object.entries(value));
};
const parseStringRecord = (
  value: unknown,
): Readonly<Record<string, string>> => {
  if (Object.prototype.toString.call(value) !== "[object Object]")
    throw new Error("Invalid string record");
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== "string"))
    throw new Error("Invalid string record");
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item)]));
};
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const checkpointField = (value: object, key: string): unknown =>
  Object.entries(value).find((entry) => entry[0] === key)?.[1];
const hasExactKeys = (value: object, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
};
const encodeCheckpointValue = (value: unknown): unknown => {
  if (value === undefined) return ["undefined", null];
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (Array.isArray(value))
    return ["array", value.map((item) => encodeCheckpointValue(item))];
  if (value !== null && typeof value === "object")
    return [
      "object",
      Object.entries(value).map(([key, item]) => [
        key,
        encodeCheckpointValue(item),
      ]),
    ];
  return ["primitive", value];
};
const decodeCheckpointValue = (value: unknown): unknown => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string"
  )
    throw new Error("Invalid encoded checkpoint value");
  if (value[0] === "undefined" && value[1] === null) return undefined;
  if (value[0] === "bigint" && typeof value[1] === "string")
    return BigInt(value[1]);
  if (value[0] === "array" && Array.isArray(value[1]))
    return value[1].map(decodeCheckpointValue);
  if (value[0] === "object" && Array.isArray(value[1]))
    return Object.fromEntries(
      value[1].map((entry) => {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string"
        )
          throw new Error("Invalid encoded checkpoint entry");
        return [entry[0], decodeCheckpointValue(entry[1])];
      }),
    );
  if (value[0] === "primitive") return value[1];
  throw new Error("Invalid encoded checkpoint tag");
};
const roundTrip = (
  state: OperationApplyState<readonly string[]>,
  alter: (value: unknown) => unknown = (value) => value,
): OperationApplyState<readonly string[]> => {
  const parsed = alter(
    decodeCheckpointValue(
      JSON.parse(JSON.stringify(encodeCheckpointValue(state))),
    ),
  );
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Invalid checkpoint");
  const checkpoint = parsed;
  const field = (key: string) => checkpointField(checkpoint, key);
  const checkpointKeys = [
    "applied",
    "baseFrontier",
    "baseProjection",
    "frontier",
    "pending",
    "projection",
    "replayCount",
    "replayHead",
    "replayLastClock",
  ];
  const applied = parseStringRecord(field("applied"));
  if (
    !hasExactKeys(checkpoint, checkpointKeys) ||
    !Array.isArray(field("pending")) ||
    !isStringArray(field("projection")) ||
    !isStringArray(field("baseProjection")) ||
    typeof field("replayCount") !== "number" ||
    !Number.isSafeInteger(field("replayCount")) ||
    Number(field("replayCount")) < 0
  )
    throw new Error("Invalid checkpoint");
  const pending = field("pending");
  const projection = field("projection");
  const baseProjection = field("baseProjection");
  if (
    !Array.isArray(pending) ||
    !Array.isArray(projection) ||
    !Array.isArray(baseProjection)
  )
    throw new Error("Invalid checkpoint");
  return {
    frontier: parseBigintRecord(field("frontier")),
    pending: pending.map(parseOperation),
    projection: projection.map(String),
    applied,
    replayHead: parseReplayEntry(field("replayHead")),
    replayCount: Number(field("replayCount")),
    replayLastClock:
      field("replayLastClock") === undefined
        ? undefined
        : parseClock(field("replayLastClock")),
    baseProjection: baseProjection.map(String),
    baseFrontier: parseBigintRecord(field("baseFrontier")),
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
    parents: parseBigintRecord(value.parents),
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

  test("rejects malformed checkpoint fields instead of normalizing them", () => {
    const state = applyAll([sequentialOperation("a", 1)]);
    const replace = (value: unknown, field: string, replacement: unknown) => {
      if (typeof value !== "object" || value === null)
        throw new Error("Expected checkpoint object");
      return {
        ...Object.fromEntries(Object.entries(value)),
        [field]: replacement,
      };
    };
    const mutations: ((value: unknown) => unknown)[] = [
      (value) => replace(value, "extra", true),
      (value) => replace(value, "frontier", { a: "1" }),
      (value) => replace(value, "applied", { key: 1n }),
      (value) => replace(value, "pending", ["operation"]),
      (value) => replace(value, "projection", [1n]),
      (value) => replace(value, "baseProjection", [1n]),
    ];
    for (const mutate of mutations)
      expect(() => roundTrip(state, mutate)).toThrow(/Invalid/);
  });

  test("round trips pending operations and releases them after restart", () => {
    const a1 = sequentialOperation("a", 1, 10);
    const a2 = sequentialOperation("a", 2, 20);
    const a3 = sequentialOperation("a", 3, 30);
    const waiting = applyOperation(arrayState(), a3, append);
    const restored = roundTrip(waiting);
    expect(restored.pending).toEqual([a3]);
    const complete = applyAll([a1, a2], restored);
    expect(complete.projection).toEqual(["a-1", "a-2", "a-3"]);
    expect(complete.frontier).toEqual({ a: 3n });
    expect(applyOperation(complete, a3, append)).toBe(complete);
  });

  test("keeps a same-writer frontier monotonic during clock-order replay", () => {
    const a1 = sequentialOperation("a", 1, 100);
    const a2 = sequentialOperation("a", 2, 50);
    const state = applyAll([a1, a2]);
    expect(state.projection).toEqual(["a-2", "a-1"]);
    expect(state.frontier).toEqual({ a: 2n });
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
