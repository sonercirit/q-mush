import { describe, expect, test } from "vitest";

import {
  MAX_PENDING_OPERATIONS,
  MAX_REMOTE_CLOCK_DRIFT_MS,
  advanceFrontier,
  applyOperation,
  classifyOperationPartition,
  compareClocks,
  compareFrontiers,
  createHybridLogicalClock,
  createOperation,
  frontierCovers,
  mergeFrontiers,
  operationEntityPartitions,
  type Operation,
  type OperationApplyState,
} from "../shared/operation-core";

type Projection = Readonly<Record<string, string>>;

const workspaceEntity = () => ({
  type: "workspaces",
  id: "workspace-1",
  accountId: "account-1",
});
const operation = (
  writerId: string,
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  value: string,
  physicalMs = Number(sequence),
) =>
  createOperation({
    operationId: `${writerId}-${sequence.toString()}`,
    schemaVersion: 1,
    writerId,
    sequence,
    clock: { physicalMs, logical: 0, writerId },
    parents,
    entity: workspaceEntity(),
    kind: "workspace.name.set",
    payload: { value },
  });

const reducer = (projection: Projection, candidate: Operation): Projection => ({
  ...projection,
  [candidate.operationId]:
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    "value" in candidate.payload &&
    typeof candidate.payload.value === "string"
      ? candidate.payload.value
      : "invalid",
});
const countingReducer = () => {
  let calls = 0;
  return {
    reduce: (projection: Projection, item: Operation) => {
      calls += 1;
      return reducer(projection, item);
    },
    calls: () => calls,
  };
};
const initialApplyState = (): OperationApplyState<Projection> => ({
  frontier: {},
  pending: [],
  projection: {},
  applied: {},
});

const stringApplyState = (): OperationApplyState<string> => ({
  frontier: {},
  pending: [],
  projection: "",
  applied: {},
});
const runStringOperations = (
  items: readonly Operation[],
  reduce: (projection: string, operation: Operation) => string,
) =>
  items.reduce<OperationApplyState<string>>(
    (state, item) => applyOperation(state, item, reduce),
    stringApplyState(),
  );
const sequentialOperation = (writerId: string, index: number) =>
  operation(
    writerId,
    BigInt(index),
    index === 1 ? {} : { [writerId]: BigInt(index - 1) },
    "x",
  );
const expectEquivocation = (
  state: OperationApplyState<Projection>,
  candidate: Operation,
  pattern: RegExp,
) => expect(() => applyOperation(state, candidate, reducer)).toThrow(pattern);

const foldOperations = (
  count: number,
  make: (index: number) => Operation,
  reduce: typeof reducer,
): OperationApplyState<Projection> => {
  let state = initialApplyState();
  for (let index = 0; index < count; index += 1)
    state = applyOperation(state, make(index), reduce);
  return state;
};
const applySequential = (count: number, reduce: typeof reducer) =>
  foldOperations(count, (index) => sequentialOperation("a", index + 1), reduce);
const waitingForGhost = () => {
  const first = operation("a", 1n, { ghost: 1n }, "one");
  return {
    first,
    waiting: applyOperation(initialApplyState(), first, reducer),
  };
};

const fillPending = (
  sequence: bigint,
  parents: Readonly<Record<string, bigint>>,
  reduce: typeof reducer,
): OperationApplyState<Projection> =>
  foldOperations(
    MAX_PENDING_OPERATIONS,
    (index) => operation(`writer-${index.toString()}`, sequence, parents, "x"),
    reduce,
  );

describe("operation core", () => {
  test("classifies every replicated schema entity", () => {
    for (const entity of operationEntityPartitions.session)
      expect(classifyOperationPartition(entity)).toBe("session");
    for (const entity of operationEntityPartitions["non-session"])
      expect(classifyOperationPartition(entity)).toBe("non-session");
    for (const excluded of ["sessions", "provider_credentials", "runners"])
      expect(() => classifyOperationPartition(excluded)).toThrow(
        /Unknown operation entity/,
      );
    expect(() => classifyOperationPartition("future_entity")).toThrow(
      /Unknown operation entity/,
    );
  });

  test("covers every HLC receive winner and rejects far-future clocks", () => {
    expect(MAX_REMOTE_CLOCK_DRIFT_MS).toBe(300_000);
    const receive = (initial: number, now: number) =>
      createHybridLogicalClock("a", initial).receive(
        { physicalMs: 110, logical: 4, writerId: "b" },
        now,
      );
    expect(receive(100, 105).logical).toBe(5);
    expect(receive(120, 105)).toMatchObject({ physicalMs: 120, logical: 1 });
    expect(receive(100, 120)).toMatchObject({ physicalMs: 120, logical: 0 });
    const nowWins = createHybridLogicalClock("a", 100);
    expect(() =>
      nowWins.receive(
        {
          physicalMs: 120 + MAX_REMOTE_CLOCK_DRIFT_MS + 1,
          logical: 0,
          writerId: "b",
        },
        120,
      ),
    ).toThrow(/future/);
  });

  test("uses a strict locale-independent clock and canonical key order", () => {
    const left = { physicalMs: 1, logical: 1, writerId: "z" };
    const right = { physicalMs: 1, logical: 1, writerId: "ä" };
    const clockComparisons = [
      compareClocks(left, right),
      compareClocks(right, left),
    ];
    expect(clockComparisons).toEqual([-1, 1]);
    const first = operation("a", 1n, {}, "one");
    const applied = applyOperation(initialApplyState(), first, reducer);
    const reordered = {
      ...first,
      payload: { value: "one" },
      entity: { accountId: "account-1", id: "workspace-1", type: "workspaces" },
    };
    expect(applyOperation(applied, reordered, reducer)).toBe(applied);
  });

  test("converges concurrent non-commutative updates across arrival permutations", () => {
    const setPayloadValue = (_projection: string, item: Operation) => {
      if (
        typeof item.payload === "object" &&
        item.payload !== null &&
        "value" in item.payload &&
        typeof item.payload.value === "string"
      )
        return item.payload.value;
      return "invalid";
    };
    const x = operation("b", 1n, {}, "X", 1);
    const y = operation("c", 1n, {}, "Y", 1);
    const run = (items: readonly Operation[]) =>
      runStringOperations(items, setPayloadValue);
    expect(run([x, y]).projection).toBe(run([y, x]).projection);
    expect(run([x, y]).projection).toBe("Y");
  });

  test("converges causal chains and concurrent writers across arrival permutations", () => {
    const setOperationId = (_projection: string, item: Operation) =>
      item.operationId;
    const items = [
      operation("a", 1n, {}, "a1", 100),
      operation("a", 2n, { a: 1n }, "a2", 200),
      operation("b", 1n, {}, "b1", 50),
    ];
    const permutations = <T>(values: readonly T[]): T[][] =>
      values.length === 0
        ? [[]]
        : values.flatMap((value, index) =>
            permutations(
              values.filter((_, itemIndex) => itemIndex !== index),
            ).map((tail) => [value, ...tail]),
          );
    const run = (ordered: readonly Operation[]) =>
      runStringOperations(ordered, setOperationId);
    for (const ordered of permutations(items)) {
      const result = run(ordered);
      expect(result.projection).toBe("a-2");
      expect(result.frontier).toEqual({ a: 2n, b: 1n });
    }
  });

  test("does not wedge after the former replay limit", () => {
    let state = initialApplyState();
    for (let index = 1; index <= 600; index += 1) {
      const sequence = BigInt(Math.ceil(index / 2));
      const writer = index % 2 === 0 ? "b" : "a";
      state = applyOperation(
        state,
        operation(
          writer,
          sequence,
          sequence === 1n ? {} : { [writer]: sequence - 1n },
          "x",
          index,
        ),
        reducer,
      );
    }
    expect(state.frontier).toEqual({ a: 300n, b: 300n });
  });

  test("distinguishes bigint and number operation fingerprints", () => {
    const first = createOperation({
      ...operation("a", 1n, { ghost: 1n }, "x"),
      payload: { value: 1n },
    });
    const waiting = applyOperation(initialApplyState(), first, reducer);
    expectEquivocation(
      waiting,
      { ...first, payload: { value: 1 } },
      /equivocation/,
    );
  });

  test("applied identity updates scale near-linearly", () => {
    const duration = (count: number) => {
      const started = performance.now();
      applySequential(count, reducer);
      return performance.now() - started;
    };
    duration(200);
    const small = duration(1_000);
    const large = duration(2_000);
    expect(large / small).toBeLessThan(3.5);
  });

  test("bounds never-ready admission without reducer work", () => {
    const counter = countingReducer();
    const state = fillPending(1n, { ghost: 9n }, counter.reduce);
    expect(counter.calls()).toBe(0);
    expect(() =>
      applyOperation(
        state,
        operation("overflow", 1n, { ghost: 9n }, "x"),
        reducer,
      ),
    ).toThrow(/pending buffer/);
  });

  test("applies a sequential stream with exactly one reducer call per operation", () => {
    const counter = countingReducer();
    const state = applySequential(800, counter.reduce);
    expect(counter.calls()).toBe(800);
    expect(state.replayCount).toBe(800);
  });

  test("admits a ready dependency into a full pending buffer and drains it", () => {
    const state = fillPending(2n, {}, reducer);
    const healed = applyOperation(
      state,
      operation("writer-0", 1n, {}, "one"),
      reducer,
    );
    expect(healed.frontier["writer-0"]).toBe(2n);
    expect(healed.pending).toHaveLength(MAX_PENDING_OPERATIONS - 1);
  });

  test("omits undefined object properties but distinguishes null from non-finite numbers", () => {
    const { first } = waitingForGhost();
    const entity = { ...first.entity };
    Object.defineProperty(entity, "workspaceId", {
      enumerable: true,
      value: undefined,
    });
    const withUndefined: Operation = { ...first, entity };
    const waiting = applyOperation(initialApplyState(), withUndefined, reducer);
    expect(
      applyOperation(
        waiting,
        {
          ...first,
          entity: workspaceEntity(),
        },
        reducer,
      ),
    ).toBe(waiting);
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(() =>
        createOperation({
          ...first,
          operationId: "bad",
          payload: { value: invalid },
        }),
      ).toThrow(/finite/);
  });

  test("validates operation shape, dates, arrays, and identity", () => {
    const validationSeed = operation("validator", 1n, { missing: 1n }, "seed");
    expect(() => createOperation({ ...validationSeed, sequence: 0n })).toThrow(
      /sequence/,
    );
    expect(() =>
      createOperation({ ...validationSeed, schemaVersion: 0 }),
    ).toThrow(/schemaVersion/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() =>
      createOperation({ ...validationSeed, payload: cyclic }),
    ).toThrow(/must not be cyclic/);
    for (const unsupported of [() => undefined, Symbol("x")])
      expect(() =>
        createOperation({ ...validationSeed, payload: unsupported }),
      ).toThrow(/Unsupported operation value/);
    expect(() =>
      createOperation({ ...validationSeed, payload: new Map() }),
    ).toThrow(/must be plain/);
    const symbolObject = { value: "x", [Symbol("x")]: "y" };
    expect(() =>
      createOperation({ ...validationSeed, payload: symbolObject }),
    ).toThrow(/string-keyed/);
    const dated = createOperation({
      ...validationSeed,
      payload: { at: new Date(1) },
    });
    const waiting = applyOperation(initialApplyState(), dated, reducer);
    expect(() =>
      applyOperation(
        waiting,
        { ...dated, payload: { at: new Date(2) } },
        reducer,
      ),
    ).toThrow(/equivocation/);
    const arrayUndefined = createOperation({
      ...validationSeed,
      operationId: "array",
      writerId: "array",
      payload: [undefined],
    });
    const arrayWaiting = applyOperation(
      initialApplyState(),
      arrayUndefined,
      reducer,
    );
    expect(() =>
      applyOperation(
        arrayWaiting,
        { ...arrayUndefined, payload: [null] },
        reducer,
      ),
    ).toThrow(/equivocation/);
  });

  test("preserves input states and resumes checkpoint-shaped durable state", () => {
    const original = initialApplyState();
    applyOperation(original, operation("a", 1n, {}, "one"), reducer);
    expect(original).toEqual(initialApplyState());
    expect(() =>
      applyOperation(
        original,
        { ...operation("a", 1n, {}, "one"), operationId: "other" },
        reducer,
      ),
    ).not.toThrow();

    const emptyProjection: readonly string[] = [];
    const seeded = applyOperation(
      {
        frontier: {},
        pending: [],
        projection: emptyProjection,
        applied: {},
      },
      operation("a", 1n, {}, "one"),
      (projection, item) => [...projection, item.operationId],
    );
    const checkpoint: OperationApplyState<readonly string[]> = {
      frontier: seeded.frontier,
      pending: [],
      projection: seeded.projection,
      applied: seeded.applied,
    };
    const append = (projection: readonly string[], item: Operation) => [
      ...projection,
      item.operationId,
    ];
    let resumed = applyOperation(
      checkpoint,
      operation("a", 3n, { a: 2n }, "three"),
      append,
    );
    resumed = applyOperation(
      resumed,
      operation("a", 2n, { a: 1n }, "two"),
      append,
    );
    expect(resumed.projection).toEqual(["a-1", "a-2", "a-3"]);
    expect(
      applyOperation(resumed, operation("a", 1n, {}, "one"), append).projection,
    ).toEqual(resumed.projection);
  });

  test("compares every frontier relation and rejects gaps and writer-sequence equivocation", () => {
    expect(compareFrontiers({ a: 1n }, { a: 1n })).toBe("equal");
    expect(compareFrontiers({ a: 1n }, { a: 2n })).toBe("ancestor");
    expect(compareFrontiers({ a: 2n }, { a: 1n })).toBe("descendant");
    expect(() => advanceFrontier({ a: 1n }, "a", 3n)).toThrow(/gap/);
    const { first, waiting } = waitingForGhost();
    expectEquivocation(
      waiting,
      { ...first, operationId: "fresh", payload: { value: "changed" } },
      /writer:a:1/,
    );
  });

  test("ticks the local hybrid clock forward and logically", () => {
    const clock = createHybridLogicalClock("a", 10);
    expect([clock.tick(20), clock.tick(20), clock.tick(15)]).toEqual([
      { physicalMs: 20, logical: 0, writerId: "a" },
      { physicalMs: 20, logical: 1, writerId: "a" },
      { physicalMs: 20, logical: 2, writerId: "a" },
    ]);
  });

  test("compares, merges, advances, buffers, and rejects equivocation", () => {
    expect(compareFrontiers({ a: 2n }, { b: 1n })).toBe("concurrent");
    expect(mergeFrontiers({ a: 2n }, { a: 1n, c: 3n })).toEqual({
      a: 2n,
      c: 3n,
    });
    expect(advanceFrontier({ a: 2n }, "a", 3n)).toEqual({ a: 3n });
    const coversAncestor = frontierCovers({ a: 2n }, { a: 1n });
    expect(coversAncestor).toBe(true);
    const causalFirst = operation("a", 1n, {}, "one");
    const second = operation("a", 2n, { a: 1n }, "two");
    const waiting = applyOperation(initialApplyState(), second, reducer);
    const applied = applyOperation(waiting, causalFirst, reducer);
    expect(applied.pending).toEqual([]);
    expect(applied.frontier).toEqual({ a: 2n });
    expect(applyOperation(applied, causalFirst, reducer)).toBe(applied);
    expectEquivocation(
      applied,
      { ...causalFirst, payload: { value: "changed" } },
      /equivocation/,
    );
  });
});
